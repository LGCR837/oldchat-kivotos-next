@echo off
set CGO_ENABLED=0

echo Building for Windows amd64...
set GOOS=windows
set GOARCH=amd64
go build -ldflags="-s -w" -o main_windows_amd64.exe main.go

echo Building for Linux amd64...
set GOOS=linux
set GOARCH=amd64
go build -ldflags="-s -w" -o main_linux_amd64 main.go

echo Done.
pause
