(() => {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
