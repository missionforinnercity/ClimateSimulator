const videos = [...document.querySelectorAll('video[data-src]')];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const saveData = Boolean(navigator.connection?.saveData);

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
