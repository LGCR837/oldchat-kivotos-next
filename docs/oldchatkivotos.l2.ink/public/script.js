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
