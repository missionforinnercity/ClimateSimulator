const videos = [...document.querySelectorAll('video[data-src]')];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const saveData = Boolean(navigator.connection?.saveData);

function animateHeroTitle() {
  if (reducedMotion.matches || !window.gsap) return;

  const titleWords = [...document.querySelectorAll('.hero-title-word')];
  if (!titleWords.length) return;

  const timeline = window.gsap.timeline({ defaults: { ease: 'power4.out' } });
  timeline
    .from(titleWords, {
      yPercent: 125,
      rotation: 3,
      opacity: 0,
      filter: 'blur(8px)',
      transformOrigin: 'left bottom',
      duration: 1.05,
      stagger: 0.075,
    }, 0.08)
    .from('.hero .kicker', {
      y: 12,
      opacity: 0,
      duration: 0.65,
    }, 0.2)
    .from(['.hero-copy', '.hero .actions'], {
      y: 18,
      opacity: 0,
      duration: 0.75,
      stagger: 0.1,
    }, 0.72);

  reducedMotion.addEventListener('change', event => {
    if (event.matches) timeline.progress(1).kill();
  }, { once: true });
}

animateHeroTitle();

function loadVideo(video) {
  if (video.dataset.loaded) return;
  video.src = video.dataset.src;
  video.dataset.loaded = 'true';
  video.load();
}

function stopAllVideos() {
  for (const video of videos) video.pause();
}

if (!reducedMotion.matches && !saveData) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const video = entry.target;
      if (entry.isIntersecting && !document.hidden) {
        loadVideo(video);
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    }
  }, { rootMargin: '180px 0px', threshold: 0.08 });

  videos.forEach(video => observer.observe(video));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAllVideos();
    else videos.filter(video => video.dataset.loaded).forEach(video => video.play().catch(() => {}));
  });
  reducedMotion.addEventListener('change', event => {
    if (event.matches) stopAllVideos();
  });
}
