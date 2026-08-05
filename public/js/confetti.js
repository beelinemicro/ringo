// Lightweight canvas confetti burst for the "RINGO!" win moment.

let raf = null;

export function burst(canvas, colors) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;

  const parts = [];
  for (let i = 0; i < 160; i++) {
    parts.push({
      x: W / 2 + (Math.random() - 0.5) * W * 0.3,
      y: H * 0.35,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 13 - 4,
      w: 6 + Math.random() * 6,
      h: 4 + Math.random() * 4,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.35,
      color: colors[i % colors.length],
    });
  }

  const start = performance.now();
  cancelAnimationFrame(raf);

  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.32;
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.99;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < 4000) {
      raf = requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, W, H);
    }
  }
  raf = requestAnimationFrame(frame);
}

export function stop(canvas) {
  cancelAnimationFrame(raf);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
