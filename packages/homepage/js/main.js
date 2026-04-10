// Scroll-triggered animations via IntersectionObserver

(function () {
  'use strict';

  // Animate elements with .animate-on-scroll when they enter the viewport
  var scrollObserver = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          scrollObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );

  document.querySelectorAll('.animate-on-scroll').forEach(function (el) {
    scrollObserver.observe(el);
  });
})();
