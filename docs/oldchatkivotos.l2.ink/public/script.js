/* ==============================================
   OldChat-Kivotos Next — 官网脚本
   ============================================== */

// Mobile menu toggle
(function () {
    const toggle = document.getElementById('mobileToggle');
    const navLinks = document.getElementById('navLinks');
    if (toggle && navLinks) {
        toggle.addEventListener('click', function () {
            navLinks.classList.toggle('open');
        });
        // Close on link click
        navLinks.querySelectorAll('a').forEach(function (link) {
            link.addEventListener('click', function () {
                navLinks.classList.remove('open');
            });
        });
    }

    // Intersection Observer for fade-in
    const observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.fade-in').forEach(function (el) {
        observer.observe(el);
    });

    // ===== 发行版下载区：从 /api/releases 动态加载（瀑布流卡片，链接内嵌）=====
    const REPO = 'LGCR837/oldchat-kivotos-next';
    const MIRROR = 'https://gh.jasonzeng.dev/'; // 纯前端镜像中转
    const TARGETS = [
        { os: 'Windows', arch: 'amd64', suffix: 'windows-amd64.exe' },
        { os: 'Windows', arch: 'arm64', suffix: 'windows-arm64.exe' },
        { os: 'Windows', arch: 'i386', suffix: 'windows-i386.exe' },
        { os: 'Linux', arch: 'amd64', suffix: 'linux-amd64' },
        { os: 'Linux', arch: 'arm64', suffix: 'linux-arm64' }
    ];

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function nl2br(s) {
        return s.replace(/\n/g, '<br>');
    }

    function assetUrl(tag, suffix) {
        const gh = 'https://github.com/' + REPO + '/releases/download/'
            + encodeURIComponent(tag) + '/oldchat-kivotos-next-app-' + encodeURIComponent(tag) + '-' + suffix;
        return MIRROR + gh;
    }

    function releaseCard(r) {
        const tag = r.tag || '';
        const title = r.name || tag;
        let desc = (r.body || '').replace(/\r/g, '').trim();
        if (!desc) desc = '该发行版未提供说明。';
        if (desc.length > 800) desc = desc.slice(0, 800) + '…';
        const links = TARGETS.map(function (t) {
            return '<a class="dl-link" href="' + esc(assetUrl(tag, t.suffix)) + '" target="_blank" rel="noopener">'
                + '<span class="dl-os">' + t.os + '</span><span class="dl-arch">' + t.arch + '</span></a>';
        }).join('');
        return '<div class="release-card fade-in visible">'
            + '<h3>' + esc(title) + (r.prerelease ? ' · 预览版' : '') + '</h3>'
            + '<p class="release-desc">' + nl2br(esc(desc)) + '</p>'
            + '<div class="dl-links">' + links + '</div>'
            + '</div>';
    }

    function noticeCard(title, text) {
        return '<div class="release-card fade-in visible">'
            + '<h3>' + esc(title) + '</h3>'
            + '<p class="release-desc">' + esc(text) + '</p>'
            + '</div>';
    }

    const grid = document.getElementById('releaseGrid');

    // 瀑布流定位：按最短列摆放，保留错位(瀑布)观感，阅读顺序大致左→右
    function layoutMasonry() {
        if (!grid) return;
        const cards = Array.prototype.slice.call(grid.querySelectorAll('.release-card'));
        if (!cards.length) { grid.style.height = ''; return; }
        const w = grid.clientWidth;
        let cols = 3;
        if (w <= 560) cols = 1;
        else if (w <= 900) cols = 2;
        const gap = 20;
        const colW = Math.floor((w - gap * (cols - 1)) / cols);
        cards.forEach(function (c) {
            c.style.position = 'absolute';
            c.style.width = colW + 'px';
        });
        const colH = [];
        for (let i = 0; i < cols; i++) colH.push(0);
        cards.forEach(function (c) {
            let min = 0;
            for (let i = 1; i < cols; i++) if (colH[i] < colH[min]) min = i;
            const x = min * (colW + gap);
            const y = colH[min];
            c.style.transform = 'translate(' + x + 'px,' + y + 'px)';
            colH[min] += c.offsetHeight + gap;
        });
        grid.style.height = Math.max.apply(null, colH) + 'px';
    }

    // 窗口尺寸变化时重排（防抖）
    let masonryTimer = null;
    window.addEventListener('resize', function () {
        if (masonryTimer) clearTimeout(masonryTimer);
        masonryTimer = setTimeout(layoutMasonry, 150);
    });

    if (grid) {
        fetch('/api/releases', { headers: { 'Accept': 'application/json' } })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                const list = (data && data.releases) || [];
                if (!list.length) {
                    grid.innerHTML = noticeCard('暂无发行版', '数据尚未初始化，请稍后再来，或前往 GitHub Releases 查看。');
                    return;
                }
                // 全部渲染（不再截断数量）
                grid.innerHTML = list.map(releaseCard).join('\n');
                // 字体/换行稳定后再定位，避免高度测算偏差
                requestAnimationFrame(function () {
                    requestAnimationFrame(layoutMasonry);
                });
            })
            .catch(function (e) {
                grid.innerHTML = noticeCard('加载失败', '无法获取发行版列表（' + e.message + '），请前往 GitHub Releases 直接下载。');
            });
    }

    // Navbar scroll effect
    const navbar = document.querySelector('.navbar');
    window.addEventListener('scroll', function () {
        const currentScroll = window.pageYOffset;
        if (currentScroll > 60) {
            navbar.style.background = 'rgba(255, 255, 255, 0.82)';
            navbar.style.borderBottomColor = 'rgba(255, 255, 255, 0.85)';
        } else {
            navbar.style.background = 'rgba(255, 255, 255, 0.55)';
            navbar.style.borderBottomColor = 'rgba(255, 255, 255, 0.7)';
        }
    });
})();
