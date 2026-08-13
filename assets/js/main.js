(() => {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Theme toggle (light / cosmic)
  const THEME_KEY = 'siteTheme';
  const themeToggle = document.getElementById('themeToggle');
  const applyTheme = (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    if (themeToggle) themeToggle.setAttribute('aria-pressed', String(theme === 'cosmic'));
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* storage unavailable */ }
  };
  if (themeToggle) {
    const current = document.documentElement.getAttribute('data-theme') === 'cosmic' ? 'cosmic' : 'light';
    themeToggle.setAttribute('aria-pressed', String(current === 'cosmic'));
    themeToggle.addEventListener('click', () => {
      const active = document.documentElement.getAttribute('data-theme') === 'cosmic' ? 'cosmic' : 'light';
      applyTheme(active === 'cosmic' ? 'light' : 'cosmic');
    });
  }

  // Mobile nav toggle
  const navToggle = document.getElementById('navToggle');
  const nav = document.getElementById('mainNav');
  if (navToggle && nav) {
    navToggle.addEventListener('click', () => {
      const isOpen = nav.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', String(isOpen));
    });
    nav.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        nav.classList.remove('is-open');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // Scroll reveal
  const revealEls = document.querySelectorAll('.reveal');
  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('is-visible'));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );
    revealEls.forEach((el) => revealObserver.observe(el));
  }

  // Pain-section photo carousel
  const painTrack = document.getElementById('painTrack');
  const painPrev = document.querySelector('[data-carousel-prev]');
  const painNext = document.querySelector('[data-carousel-next]');
  if (painTrack && painPrev && painNext) {
    const scrollByCard = (dir) => {
      const card = painTrack.querySelector('.photo-card');
      const amount = card ? card.getBoundingClientRect().width + 12 : painTrack.clientWidth * 0.8;
      painTrack.scrollBy({ left: dir * amount, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    };
    painPrev.addEventListener('click', () => scrollByCard(-1));
    painNext.addEventListener('click', () => scrollByCard(1));
    const updateCarouselButtons = () => {
      const max = painTrack.scrollWidth - painTrack.clientWidth - 2;
      painPrev.disabled = painTrack.scrollLeft <= 2;
      painNext.disabled = painTrack.scrollLeft >= max;
    };
    painTrack.addEventListener('scroll', updateCarouselButtons, { passive: true });
    window.addEventListener('resize', updateCarouselButtons);
    updateCarouselButtons();
  }

  // Growing path line in "Как мы работаем"
  const pathTrack = document.getElementById('pathTrack');
  const pathFill = document.getElementById('pathFill');
  if (pathTrack && pathFill) {
    if (prefersReducedMotion) {
      pathFill.style.height = '100%';
    } else {
      const updatePathFill = () => {
        const rect = pathTrack.getBoundingClientRect();
        const viewportH = window.innerHeight;
        const start = viewportH * 0.85;
        const end = viewportH * 0.25;
        const total = rect.height;
        let progress = (start - rect.top) / (start - end + total);
        progress = Math.max(0, Math.min(1, progress));
        pathFill.style.height = `${progress * 100}%`;
      };
      let ticking = false;
      window.addEventListener('scroll', () => {
        if (!ticking) {
          requestAnimationFrame(() => {
            updatePathFill();
            ticking = false;
          });
          ticking = true;
        }
      }, { passive: true });
      window.addEventListener('resize', updatePathFill);
      updatePathFill();
    }
  }
})();
