/**
 * hero-shader.js — drop-in interactive shader background.
 *
 * Single fragment-shader plasma effect: orbiting wave sources interfere on a
 * dark warm-neutral palette; the cursor is its own wave emitter; clicks drop
 * transient pulses. Tuned for the artufe.github.io hero: minimal intensity,
 * slow drift, almost no grain.
 *
 * Usage:
 *   <canvas id="hero-bg" style="position:fixed;inset:0;width:100%;height:100%;z-index:-1"></canvas>
 *   <script src="hero-shader.js"></script>
 *   <script>HeroShader.mount(document.getElementById('hero-bg'));</script>
 *
 * Or with options:
 *   HeroShader.mount(canvas, {
 *     intensity: 0.55, speed: 0.35, grain: 0.012,
 *     seed: 0,                          // per-mount phase offset
 *     deep:   [0.02, 0.025, 0.035],     // background / vignette color
 *     mid:    [0.06, 0.09, 0.14],       // midtone
 *     accent: [0.95, 0.72, 0.35],       // bright color in highlights
 *   });
 *
 * No deps. ~3KB minified. Auto-pauses when offscreen / tab hidden.
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

    #define PI 3.14159265359

    float hash21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }

    void main(){
      vec2 uv = gl_FragCoord.xy / uRes.xy;
      vec2 p = (uv - 0.5);
      p.x *= uRes.x/uRes.y;

      float t = uTime * 0.6 * uSpeed;

      float v = 0.0;
      for(int i=0;i<4;i++){
        float fi = float(i);
        vec2 s = vec2(cos(t*0.4 + fi*1.7 + uSeed), sin(t*0.5 + fi*2.3 + uSeed*1.3)) * 0.35;
        v += sin(length(p - s)*14.0 - t*2.0 + fi);
      }

      vec2 m = uMouse;
      m.x = (m.x - 0.5) * (uRes.x/uRes.y);
      m.y -= 0.5;
      v += sin(length(p - m)*22.0 - t*3.0) * 1.4;

      vec2 cp = vec2((uClickPos.x-0.5)*uRes.x/uRes.y, uClickPos.y-0.5);
      v += sin(length(p - cp)*30.0 - uTime*8.0) * uClick * 1.6;

      v /= 6.0;

      float a = 0.5 + 0.5*sin(v*PI*2.0 + t);
      float b = 0.5 + 0.5*cos(v*PI*2.0 - t*0.7);

      vec3 col = mix(uDeep, uMid, a);
      col = mix(col, uAccent, pow(b, 3.0) * 0.85 * uIntensity);
      col += exp(-length(p-m)*length(p-m)*10.0) * uAccent * 0.2 * uIntensity;

      vec2 q = uv - 0.5;
      col = mix(uDeep, col, smoothstep(0.95, 0.25, dot(q,q)));

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
    ['uRes','uTime','uMouse','uClick','uClickPos','uIntensity','uGrain','uSpeed','uSeed','uDeep','uMid','uAccent']
      .forEach(k => u[k] = gl.getUniformLocation(prog, k));

    // Defaults — tuned for hero use: lowest intensity, slow speed, almost no
    // grain. Palette defaults to the prior hardcoded amber-on-near-black.
    const state = {
      intensity: opts.intensity ?? 0.55,
      speed:     opts.speed     ?? 0.35,
      grain:     opts.grain     ?? 0.012,
      seed:      opts.seed      ?? 0,
      deep:   opts.deep   ?? [0.02, 0.025, 0.035],
      mid:    opts.mid    ?? [0.06, 0.09, 0.14],
      accent: opts.accent ?? [0.95, 0.72, 0.35],
      mouse: [0.5, 0.5],
      click: 0,
      clickPos: [0.5, 0.5],
    };

    const target = opts.eventTarget || canvas;
    const onMove = (e) => {
      const r = canvas.getBoundingClientRect();
      state.mouse = [
        (e.clientX - r.left) / r.width,
        1 - (e.clientY - r.top) / r.height,
      ];
    };
    const onDown = (e) => {
      const r = canvas.getBoundingClientRect();
      state.clickPos = [
        (e.clientX - r.left) / r.width,
        1 - (e.clientY - r.top) / r.height,
      ];
      state.click = 1;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mousedown', onDown);

    const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
    function resize(){
      const w = Math.floor(canvas.clientWidth * dpr());
      const h = Math.floor(canvas.clientHeight * dpr());
      if(canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
    }

    let raf, running = true, t0 = performance.now();
    function frame(){
      if(!running){ raf = requestAnimationFrame(frame); return; }
      resize();
      const t = (performance.now() - t0) / 1000;
      state.click *= 0.94;

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
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      raf = requestAnimationFrame(frame);
    }
    frame();

    // pause when tab hidden or canvas offscreen
    const onVis = () => { running = !document.hidden; };
    document.addEventListener('visibilitychange', onVis);

    let io;
    if('IntersectionObserver' in window){
      io = new IntersectionObserver(([entry]) => {
        running = entry.isIntersecting && !document.hidden;
      });
      io.observe(canvas);
    }

    return {
      set(opts){ Object.assign(state, opts); },
      stop(){
        running = false;
        cancelAnimationFrame(raf);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mousedown', onDown);
        document.removeEventListener('visibilitychange', onVis);
        if(io) io.disconnect();
      },
    };
  }

  root.HeroShader = { mount };
})(typeof window !== 'undefined' ? window : this);
