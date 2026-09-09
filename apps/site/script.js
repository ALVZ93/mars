const menuButton = document.querySelector('.menu-toggle');
const mobileNav = document.querySelector('#mobile-nav');

function closeMenu() {
  if (!menuButton || !mobileNav) return;
  menuButton.setAttribute('aria-expanded', 'false');
  mobileNav.hidden = true;
}

menuButton?.addEventListener('click', () => {
  const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!isOpen));
  mobileNav.hidden = isOpen;
});

mobileNav?.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const revealItems = document.querySelectorAll('.reveal');
if (reduceMotion.matches || !('IntersectionObserver' in window)) {
  revealItems.forEach(item => item.classList.add('is-visible'));
} else {
  const revealObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -12% 0px' });
  revealItems.forEach(item => revealObserver.observe(item));
}

document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const target = document.querySelector(button.getAttribute('data-copy'));
    const status = button.parentElement?.querySelector('.copy-status');
    const value = target?.textContent?.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = 'Copied';
      if (status) status.textContent = 'Command copied to clipboard.';
    } catch {
      button.textContent = 'Select command';
      if (status) status.textContent = 'Clipboard unavailable; select the command above.';
    }
    window.setTimeout(() => { button.textContent = 'Copy command'; }, 1800);
  });
});

if (!reduceMotion.matches) {
  const planet = document.querySelector('.hero-planet');
  let ticking = false;
  const updateParallax = () => {
    ticking = false;
    if (!planet) return;
    const offset = Math.min(Math.max(window.scrollY * 0.035, 0), 34);
    planet.style.setProperty('--scroll-offset', String(offset) + 'px');
  };
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(updateParallax);
  }, { passive: true });
  updateParallax();
}
