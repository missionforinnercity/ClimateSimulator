const links = Array.from(document.querySelectorAll('.docs-side a'));
const sections = links.map((a) => document.querySelector(a.getAttribute('href')));

function setActive() {
  let current = sections[0];
  for (const section of sections) {
    if (section && section.getBoundingClientRect().top - 90 <= 0) current = section;
  }
  links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + (current && current.id)));
}

document.addEventListener('scroll', setActive, { passive: true });
setActive();
