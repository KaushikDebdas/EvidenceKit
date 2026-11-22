// Click ripples shown in the page while the screen recorder runs (so viewers can see where you clicked).
(() => {
  if (window.__evkClicksOn) return;
  window.__evkClicksOn = true;

  const host = document.createElement('div');
  host.setAttribute('data-evk', 'clicks');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .r{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #f59e0b;background:rgba(245,158,11,.28);
       animation:q .55s ease-out forwards;pointer-events:none}
    .r.right{border-color:#6366f1;background:rgba(99,102,241,.28)}
    @keyframes q{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}
  </style>`;
  document.documentElement.append(host);

  const onDown = (e) => {
    const d = document.createElement('div');
    d.className = 'r' + (e.button === 2 ? ' right' : '');
    d.style.left = e.clientX + 'px';
    d.style.top = e.clientY + 'px';
    root.append(d);
    setTimeout(() => d.remove(), 600);
  };
  window.addEventListener('pointerdown', onDown, true);

  window.__evkClicksOff = () => {
    window.removeEventListener('pointerdown', onDown, true);
    host.remove();
    window.__evkClicksOn = false;
    window.__evkClicksOff = null;
  };
})();
