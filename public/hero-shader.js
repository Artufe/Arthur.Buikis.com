/**
 * hero-shader.js — drop-in interactive shader background.
 *
 * Single fragment-shader effect: domain-warped value-noise FBM rendered as
 * topographic contour bands over a faint engineering grid, with amber crests
 * along ridges. The cursor warps the noise locally; clicks drop a transient
 * ring ripple. Tuned for the artufe.github.io hero: composed even when
 * static, sharp lines, no soft halos.
 *
 * Usage:
 *   <canvas id="hero-bg" style="position:fixed;inset:0;width:100%;height:100%;z-index:-1"></canvas>
 *   <script src="hero-shader.js"></script>
 *   <script>HeroShader.mount(document.getElementById('hero-bg'));</script>
 *
 * Or with options:
 *   HeroShader.mount(canvas, {
 *     intensity: 0.55, speed: 0.35, grain: 0.012, gridIntensity: 0.4,
 *     seed: 0,
 *     deep:   [0.02, 0.025, 0.035],
 *     mid:    [0.30, 0.62, 0.74],
 *     accent: [1.00, 0.72, 0.30],
 *   });
 *
 * No deps. Auto-pauses when offscreen / tab hidden.
 */
(function (root) {
  const VERT = `
    attribute vec2 aPos;
    void main(){ gl_Position = vec4(aPos,0.0,1.0); }
  `;

  const FRAG = `
    precision highp float;
    uniform vec2  uRes;
    uniform float uTime;
    uniform vec2  uMouse;
    uniform float uClick;
    uniform vec2  uClickPos;
    uniform float uIntensity;
    uniform float uGrain;
    uniform float uSpeed;
    uniform float uSeed;
    uniform vec3  uDeep;
    uniform vec3  uMid;
    uniform vec3  uAccent;
    uniform float uGridIntensity;

    #define PI 3.14159265359
    #define BANDS 7.0
    #define GRID_PX 64.0

    float hash21(vec2 p){
      p = fract(p*vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float vnoise(vec2 p){
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f*f*(3.0 - 2.0*f);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    float fbm(vec2 p){
      return vnoise(p) * 0.6 + vnoise(p * 2.13 + 17.0) * 0.4;
    }

    void main(){
      vec2 uv = gl_FragCoord.xy / uRes.xy;
      float aspect = uRes.x / uRes.y;
      vec2 p = (uv - 0.5);
      p.x *= aspect;

      float t = uTime * 0.18 * uSpeed;

      vec2 m;
      m.x = (uMouse.x - 0.5) * aspect;
      m.y = uMouse.y - 0.5;
      float mdist = length(p - m);
      vec2 mPull = (p - m) * exp(-mdist*mdist*5.0) * 0.22;

      vec2 cp;
      cp.x = (uClickPos.x - 0.5) * aspect;
      cp.y = uClickPos.y - 0.5;
      float cdist = length(p - cp);

      vec2 q = p * 1.4 + vec2(uSeed * 0.3, uSeed * 0.5);
      q += 0.18 * vec2(
        sin(q.y * 1.3 + t * 1.0),
        cos(q.x * 1.1 - t * 0.7)
      );
      q -= mPull;

      float field = fbm(q + vec2(t * 0.05, t * 0.07));
      field += sin(cdist * 22.0 - uTime * 4.0) * uClick * 0.06;

      float bands = field * BANDS;
      float d = abs(fract(bands) - 0.5) * 2.0;
      // Resolution-aware AA width — keeps lines ~2px at any DPR without needing
      // OES_standard_derivatives. Tuned by eye against the blueprint mood ref.
      float aaBand = clamp(220.0 / min(uRes.x, uRes.y), 0.012, 0.08);
      float line = 1.0 - smoothstep(0.0, aaBand, d);

      float crest = smoothstep(0.78, 0.95, field);

      vec2 gridPos = gl_FragCoord.xy / GRID_PX;
      vec2 gd = abs(fract(gridPos) - 0.5);
      float gridMax = max(gd.x, gd.y);
      float gridLine = 1.0 - smoothstep(0.46, 0.5, gridMax);
      float gridDot  = smoothstep(0.92, 1.0, 1.0 - gridMax * 2.0);

      vec3 col = uDeep;
      col += uMid    * gridLine * uGridIntensity * 0.35;
      col += uMid    * line     * uIntensity     * 0.85;
      col += uAccent * crest    * uIntensity     * 0.55;
      col += uAccent * gridDot  * uGridIntensity * 0.15;
      col += exp(-mdist*mdist*18.0) * uAccent * 0.08 * uIntensity;

      vec2 vg = uv - 0.5;
      col = mix(uDeep, col, smoothstep(0.95, 0.20, dot(vg, vg)));

      float n = hash21(uv*uRes + uTime*60.0) - 0.5;
      col += n * uGrain;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compile(gl, src, type){
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function mount(canvas, opts){
    opts = opts || {};
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
    if(!gl){ console.warn('[hero-shader] WebGL unavailable'); return { stop(){} }; }

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, VERT, gl.VERTEX_SHADER));
    gl.attachShader(prog, compile(gl, FRAG, gl.FRAGMENT_SHADER));
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');

    const u = {};
    ['uRes','uTime','uMouse','uClick','uClickPos','uIntensity','uGrain','uSpeed','uSeed','uDeep','uMid','uAccent','uGridIntensity']
      .forEach(k => u[k] = gl.getUniformLocation(prog, k));

    const state = {
      intensity:     opts.intensity     ?? 0.55,
      speed:         opts.speed         ?? 0.35,
      grain:         opts.grain         ?? 0.012,
      seed:          opts.seed          ?? 0,
      gridIntensity: opts.gridIntensity ?? 0.4,
      deep:   opts.deep   ?? [0.04, 0.05, 0.07],
      mid:    opts.mid    ?? [0.30, 0.62, 0.74],
      accent: opts.accent ?? [1.00, 0.72, 0.30],
      mouse: [0.5, 0.5],
      click: 0,
      clickPos: [0.5, 0.5],
    };

    const setMouseAt = (clientX, clientY) => {
      const r = canvas.getBoundingClientRect();
      state.mouse = [
        (clientX - r.left) / r.width,
        1 - (clientY - r.top) / r.height,
      ];
    };
    const setClickAt = (clientX, clientY) => {
      const r = canvas.getBoundingClientRect();
      state.clickPos = [
        (clientX - r.left) / r.width,
        1 - (clientY - r.top) / r.height,
      ];
      state.click = 1;
    };

    const onMove = (e) => setMouseAt(e.clientX, e.clientY);
    const onDown = (e) => setClickAt(e.clientX, e.clientY);

    const onTouchStart = (e) => {
      const t = e.touches[0];
      if(!t) return;
      setMouseAt(t.clientX, t.clientY);
      setClickAt(t.clientX, t.clientY);
    };
    const onTouchMove = (e) => {
      const t = e.touches[0];
      if(!t) return;
      setMouseAt(t.clientX, t.clientY);
    };

    const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
    function resize(){
      const w = Math.floor(canvas.clientWidth * dpr());
      const h = Math.floor(canvas.clientHeight * dpr());
      if(canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
    }

    function draw(t){
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(u.uRes, canvas.width, canvas.height);
      gl.uniform1f(u.uTime, t);
      gl.uniform2f(u.uMouse, state.mouse[0], state.mouse[1]);
      gl.uniform1f(u.uClick, state.click);
      gl.uniform2f(u.uClickPos, state.clickPos[0], state.clickPos[1]);
      gl.uniform1f(u.uIntensity, state.intensity);
      gl.uniform1f(u.uGrain, state.grain);
      gl.uniform1f(u.uSpeed, state.speed);
      gl.uniform1f(u.uSeed, state.seed);
      gl.uniform3fv(u.uDeep, state.deep);
      gl.uniform3fv(u.uMid, state.mid);
      gl.uniform3fv(u.uAccent, state.accent);
      gl.uniform1f(u.uGridIntensity, state.gridIntensity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    let raf, running = true, t0 = performance.now();
    function frame(){
      if(!running){ raf = requestAnimationFrame(frame); return; }
      resize();
      const t = (performance.now() - t0) / 1000;
      state.click *= 0.94;
      draw(t);
      raf = requestAnimationFrame(frame);
    }

    function renderStatic(){
      resize();
      state.click = 0;
      draw(0);
    }

    const onVis = () => { running = !document.hidden; };
    const onResize = () => renderStatic();

    let io;
    let animating = false;
    function startAnimation(){
      if(animating) return;
      animating = true;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mousedown', onDown);
      window.addEventListener('touchstart', onTouchStart, { passive: true });
      window.addEventListener('touchmove', onTouchMove, { passive: true });
      document.addEventListener('visibilitychange', onVis);
      if('IntersectionObserver' in window){
        io = new IntersectionObserver(([entry]) => {
          running = entry.isIntersecting && !document.hidden;
        });
        io.observe(canvas);
      }
      t0 = performance.now();
      running = true;
      frame();
    }
    function stopAnimation(){
      if(!animating) return;
      animating = false;
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('visibilitychange', onVis);
      if(io){ io.disconnect(); io = null; }
    }

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    function applyMotionPreference(){
      if(reducedMotion && reducedMotion.matches){
        stopAnimation();
        renderStatic();
        window.addEventListener('resize', onResize);
      } else {
        window.removeEventListener('resize', onResize);
        startAnimation();
      }
    }
    applyMotionPreference();
    reducedMotion?.addEventListener('change', applyMotionPreference);

    return {
      set(opts){
        Object.assign(state, opts);
        if(!animating) renderStatic();
      },
      stop(){
        stopAnimation();
        window.removeEventListener('resize', onResize);
        reducedMotion?.removeEventListener('change', applyMotionPreference);
      },
    };
  }

  root.HeroShader = { mount };
})(typeof window !== 'undefined' ? window : this);
