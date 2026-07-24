package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Port      int    `json:"port"`
	Upstream  string `json:"upstream"`
	StaticDir string `json:"static_dir"`
}

func loadConfig() Config {
	cfg := Config{
		Port:      5520,
		Upstream:  "http://60.205.94.101:8080",
		StaticDir: "./public",
	}
	data, err := os.ReadFile("config.json")
	if err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	if cfg.Port == 0 {
		cfg.Port = 5520
	}
	if cfg.Upstream == "" {
		cfg.Upstream = "http://60.205.94.101:8080"
	}
	if cfg.StaticDir == "" {
		cfg.StaticDir = "./public"
	}
	return cfg
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Max-Age", "86400")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func newProxyHandler(upstream *url.URL) http.Handler {
	return &httputil.ReverseProxy{
		Director: func(r *http.Request) {
			r.URL.Scheme = upstream.Scheme
			r.URL.Host = upstream.Host
			r.Host = upstream.Host
		},
	}
}

func newWSProxyHandler(upstream *url.URL) http.Handler {
	dialer := &net.Dialer{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetConn, err := dialer.Dial("tcp", upstream.Host)
		if err != nil {
			http.Error(w, "Cannot connect to upstream", http.StatusBadGateway)
			return
		}
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			targetConn.Close()
			http.Error(w, "WebSocket not supported", http.StatusInternalServerError)
			return
		}

		clientConn, _, err := hijacker.Hijack()
		if err != nil {
			targetConn.Close()
			http.Error(w, "Hijack failed", http.StatusInternalServerError)
			return
		}

		// Forward the original HTTP upgrade request
		reqLine := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\n", r.URL.RequestURI(), upstream.Host)
		var headerLines string
		for key, vals := range r.Header {
			for _, v := range vals {
				if key == "Host" || key == "Connection" || key == "Upgrade" {
					continue
				}
				headerLines += fmt.Sprintf("%s: %s\r\n", key, v)
			}
		}
		headerStr := reqLine + "Connection: Upgrade\r\nUpgrade: websocket\r\n" + headerLines + "\r\n"

		_, err = targetConn.Write([]byte(headerStr))
		if err != nil {
			clientConn.Close()
			targetConn.Close()
			return
		}

		// Bidirectional pipe
		done := make(chan struct{}, 2)
		go func() {
			io.Copy(targetConn, clientConn)
			done <- struct{}{}
		}()
		go func() {
			io.Copy(clientConn, targetConn)
			done <- struct{}{}
		}()
		<-done
		clientConn.Close()
		targetConn.Close()
		<-done
	})
}

func main() {
	cfg := loadConfig()

	upstream, err := url.Parse(cfg.Upstream)
	if err != nil {
		log.Fatalf("Invalid upstream URL: %v", err)
	}

	proxyHandler := newProxyHandler(upstream)
	wsProxyHandler := newWSProxyHandler(upstream)

	absStaticDir, _ := filepath.Abs(cfg.StaticDir)
	fileServer := http.FileServer(http.Dir(absStaticDir))

	mux := http.NewServeMux()

	// WebSocket proxy
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		wsProxyHandler.ServeHTTP(w, r)
	})

	// API proxy: /v1/*
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		proxyHandler.ServeHTTP(w, r)
	})

	// Static files with SPA fallback
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(absStaticDir, filepath.Clean(r.URL.Path))

		// Serve file if it exists
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}

		// SPA fallback for .html or root
		if r.URL.Path == "/" || strings.HasSuffix(r.URL.Path, ".html") {
			indexPath := filepath.Join(absStaticDir, "index.html")
			if _, err := os.Stat(indexPath); err == nil {
				http.ServeFile(w, r, indexPath)
				return
			}
		}

		// Try with .html extension
		if _, err := os.Stat(path + ".html"); err == nil {
			http.ServeFile(w, r, path+".html")
			return
		}

		fileServer.ServeHTTP(w, r)
	})

	handler := corsMiddleware(mux)

	addr := fmt.Sprintf(":%d", cfg.Port)
	fmt.Printf("OldChat Proxy running on http://localhost%s\n", addr)
	fmt.Printf("Upstream: %s\n", cfg.Upstream)
	fmt.Printf("Static dir: %s\n", absStaticDir)
	log.Fatal(http.ListenAndServe(addr, handler))
}
