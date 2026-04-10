// Flow visualization: scroll-triggered entrance + cycling highlight

(function () {
  'use strict';

  var track = document.querySelector('.flow-track');
  if (!track) return;

  var steps = track.querySelectorAll('.flow-step');
  var cycleInterval = null;
  var currentStep = 0;

  function startCycling() {
    track.classList.add('cycling');
    currentStep = 0;
    highlightStep(currentStep);

    cycleInterval = setInterval(function () {
      currentStep = (currentStep + 1) % steps.length;
      highlightStep(currentStep);
    }, 2000);
  }

  function highlightStep(index) {
    steps.forEach(function (step) {
      step.classList.remove('active');
    });
    steps[index].classList.add('active');
  }

  // Trigger entrance animation on scroll
  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          track.classList.add('playing');
          observer.unobserve(track);

          // Start cycling highlight after entrance animation completes (~3.2s)
          setTimeout(startCycling, 3200);
        }
      });
    },
    { threshold: 0.3 }
  );

  observer.observe(track);

  // Pause cycling when not visible to save resources
  var visibilityObserver = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting && cycleInterval) {
          clearInterval(cycleInterval);
          cycleInterval = null;
        } else if (entry.isIntersecting && !cycleInterval && track.classList.contains('cycling')) {
          startCycling();
        }
      });
    },
    { threshold: 0.1 }
  );

  visibilityObserver.observe(track);
})();
