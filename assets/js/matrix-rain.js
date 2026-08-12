// Matrix-style falling code background for the anketa (parent questionnaire)
// admin page. Self-contained, no dependencies. Pauses automatically for
// prefers-reduced-motion.

(function () {
  window.startMatrixRain = function (canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const glyphs = "01アイウエオカキクケコサシスセソタチツテト$#@%&+=<>";
    const fontSize = 16;
    let columns, drops;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      columns = Math.floor(canvas.width / fontSize);
      drops = new Array(columns).fill(1);
    }

    function draw() {
      ctx.fillStyle = "rgba(5, 8, 5, 0.08)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = fontSize + "px monospace";

      for (let i = 0; i < drops.length; i++) {
        const char = glyphs[Math.floor(Math.random() * glyphs.length)];
        ctx.fillStyle = Math.random() > .97 ? "#c9ffd8" : "#39ff6a";
        ctx.fillText(char, i * fontSize, drops[i] * fontSize);

        if (drops[i] * fontSize > canvas.height && Math.random() > .975) {
          drops[i] = 0;
        }
        drops[i]++;
      }
    }

    resize();
    window.addEventListener("resize", resize);

    if (reduceMotion) {
      // Draw a single static-ish frame instead of a continuous loop.
      draw();
      return;
    }

    let timer = setInterval(draw, 45);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearInterval(timer);
      } else {
        timer = setInterval(draw, 45);
      }
    });
  };
})();
