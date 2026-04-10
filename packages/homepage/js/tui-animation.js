// TUI animation: uptime counter + live event appearance

(function () {
  'use strict';

  var uptimeEl = document.getElementById('tui-uptime');
  var tuiWrapper = document.querySelector('.tui-wrapper');
  if (!uptimeEl || !tuiWrapper) return;

  var minutes = 14;
  var uptimeInterval = null;

  function startUptime() {
    uptimeInterval = setInterval(function () {
      minutes++;
      uptimeEl.textContent = minutes + 'm';
    }, 4000); // Accelerated: 1 "minute" every 4 real seconds
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !uptimeInterval) {
          startUptime();
        } else if (!entry.isIntersecting && uptimeInterval) {
          clearInterval(uptimeInterval);
          uptimeInterval = null;
        }
      });
    },
    { threshold: 0.2 }
  );

  observer.observe(tuiWrapper);
})();
