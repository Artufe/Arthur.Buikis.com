(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,83493,e=>{"use strict";var t=e.i(8359),i=e.i(27919),s=e.i(10335),r=e.i(4065),a=e.i(10755);let o=48*Math.PI/180;function n(e,t,i,s,r){let a=2/s,o=a*r,n=1/(1+o+.48*o*o+.235*o*o*o),l=e-t,h=(i.v+a*l)*r;return i.v=(i.v-a*h)*n,t+(l+h)*n}class l{camera=new t.PerspectiveCamera(42,1,.5,1200);fx=0;fz=0;vx={v:0};vz={v:0};blend=0;dist=30;idleTime=0;shakeAmp=0;reduced=!1;sunAzimuth=0;raycaster=new t.Raycaster;ground=new t.Plane(new t.Vector3(0,1,0),0);tmpPos=new t.Vector3;tmpLook=new t.Vector3;idlePos=new t.Vector3;idleLook=new t.Vector3;hit=new t.Vector3;setAspect(e){let t=e<.8;this.camera.aspect=e,this.camera.fov=t?50:42,this.dist=t?34:27,this.camera.updateProjectionMatrix()}setReducedMotion(e){this.reduced=e,e&&(this.shakeAmp=0)}setSunAzimuth(e){this.sunAzimuth=e}shake(e){this.reduced||(this.shakeAmp=Math.max(this.shakeAmp,e))}focus(){return{x:this.fx,z:this.fz}}update(e,t,i,s,r=null){let a,l,h,u=+("idle"!==s);this.blend=this.reduced?u:Math.max(0,Math.min(1,this.blend+Math.sign(u-this.blend)*(e/1.2)));let d="gameover"===s?{x:t.x,z:t.z+4.5}:(a=t.x+3.5*Math.cos(i),(h=Math.hypot(a,l=t.z+3.5*Math.sin(i)))>11?{x:a/h*11,z:l/h*11}:{x:a,z:l});if(r&&"playing"===s){let e=.5*Math.max(0,1-Math.hypot(r.x-d.x,r.z-d.z)/24);d.x+=(r.x-d.x)*e,d.z+=(r.z-d.z)*e}if(this.reduced)this.fx=d.x,this.fz=d.z;else{let t="gameover"===s?.175:.35;this.fx=n(this.fx,d.x,this.vx,t,e),this.fz=n(this.fz,d.z,this.vz,t,e)}let c=this.dist*("gameover"===s?.8:1);this.tmpPos.set(this.fx,c*Math.sin(o),this.fz+c*Math.cos(o)),this.tmpLook.set(this.fx,0,this.fz),this.idleTime+=e;let f=this.reduced?0:.2*Math.sin(.12*this.idleTime),p=this.sunAzimuth+Math.PI/2+f,m=.5*this.dist,g=t.x,v=t.z+1.2;this.idlePos.set(g+Math.cos(p)*m,.36*m,v+Math.sin(p)*m);let w=1.27*m;this.idleLook.set(g-Math.cos(p)*w,0,v-Math.sin(p)*w);let x=this.blend*this.blend*(3-2*this.blend);this.camera.position.lerpVectors(this.idlePos,this.tmpPos,x),this.tmpLook.lerpVectors(this.idleLook,this.tmpLook,x),this.shakeAmp>.001&&(this.camera.position.x+=(Math.random()-.5)*this.shakeAmp,this.camera.position.y+=(Math.random()-.5)*this.shakeAmp,this.shakeAmp*=Math.exp(-(7*e))),this.camera.lookAt(this.tmpLook)}screenToGround(e,i){this.raycaster.setFromCamera(new t.Vector2(e,i),this.camera);let s=this.raycaster.ray.intersectPlane(this.ground,this.hit);return s?{x:s.x,z:s.z}:null}}var h=e.i(34673);let u=h.ARENA_R+3;function d(e,t){return .18*Math.sin(.21*e+.3)*Math.cos(.17*t)+.1*Math.sin(.37*e+.53*t)}let c=`
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}
`,f=`
#define DUNE_START ${u.toFixed(1)}
float arenaUndulation(vec2 p) {
  return 0.1800 * sin(0.2100 * p.x + 0.3000) * cos(0.1700 * p.y)
       + 0.1000 * sin(0.3700 * p.x + 0.5300 * p.y);
}
float duneField(vec2 p) {
  float warp = fbm(p * 0.018);
  float phase = dot(p, vec2(0.82, 0.57)) * 0.085 + warp * 6.0;
  // Rounded crests: a sharp ridge turns into a saw-tooth silhouette on the coarse far mesh.
  float crest = pow(max(0.0, 0.5 + 0.5 * cos(2.0 * phase)), 1.5);
  return crest * 6.5 + fbm(p * 0.05) * 3.0;
}
float terrainHeight(vec2 p) {
  float r = length(p);
  float m = smoothstep(DUNE_START, DUNE_START + 13.0, r);
  float grow = 0.6 + 0.4 * smoothstep(30.0, 80.0, r);
  return mix(arenaUndulation(p), duneField(p) * grow, m);
}
`,p=new t.Color(2.4,.55,.95),m=new t.Color(2.6,1.8,.5),g=(e,t)=>e+Math.random()*(t-e);class v{sand;sparks;flash;flashLevel;flashDecay;sprayCarry;wispCarry;sparkleCarry;budget;reduced;dust;chunk;constructor(e,i){this.sand=e,this.sparks=i,this.flash=new t.PointLight(0xffffff,0,11,2),this.flashLevel=0,this.flashDecay=9,this.sprayCarry=0,this.wispCarry=0,this.sparkleCarry=0,this.budget=1,this.reduced=!1,this.dust=new t.Color("#e9c28f"),this.chunk=new t.Color("#f2cd98")}setDust(e){this.dust.copy(e)}setChunk(e){this.chunk.copy(e)}setBudget(e){this.budget=e}setReducedMotion(e){this.reduced=e}spray(e,t,i,s){if(this.reduced)return;this.sprayCarry+=i/5*34*this.budget*s;let r=-Math.cos(t),a=-Math.sin(t),o=d(e.x,e.z);for(;this.sprayCarry>=1;){this.sprayCarry-=1;let t=g(-1,1);this.sand.emit({x:e.x+.35*r,y:o+.05,z:e.z+.35*a,vx:r*g(.5,1.5)-a*t,vy:g(.8,1.8),vz:a*g(.5,1.5)+r*t,life:g(.5,.9),size:g(.12,.22),alpha:.55,color:this.dust,gravity:6,drag:1.2})}}eatBurst(e,t){let i=this.budget*(this.reduced?.4:1),s=d(e.x,e.z);for(let t=0;t<Math.round(36*i);t++){let t=Math.random()*Math.PI*2,i=g(1.5,4);this.sand.emit({x:e.x,y:s+.1,z:e.z,vx:Math.cos(t)*i,vy:g(1.5,3.5),vz:Math.sin(t)*i,life:g(.6,1.1),size:g(.14,.3),alpha:.7,color:this.dust,gravity:7,drag:1.5})}let r="golden"===t?m:p;for(let s=0;s<Math.round(("golden"===t?28:14)*i);s++){let t=Math.random()*Math.PI*2,i=g(1,3);this.sparks.emit({x:e.x,y:e.y,z:e.z,vx:Math.cos(t)*i,vy:g(.5,2.5),vz:Math.sin(t)*i,life:g(.4,.8),size:g(.06,.12),alpha:1,color:r,gravity:2,drag:2})}this.flash.color.set("golden"===t?"#ffc043":"#ff4a6e"),this.flash.position.copy(e),this.flashLevel="golden"===t?22:14,this.flashDecay=9}puff(e){for(let t=0;t<Math.round(14*this.budget);t++){let t=Math.random()*Math.PI*2;this.sand.emit({x:e.x,y:e.y,z:e.z,vx:Math.cos(t)*g(.3,1),vy:g(.2,.8),vz:Math.sin(t)*g(.3,1),life:g(.6,1),size:g(.2,.35),alpha:.45,grow:.8,color:this.dust,drag:2})}}deathDust(e){let t=this.budget*(this.reduced?.5:1);for(let i=0;i<e.length;i+=4){let s=e[i],r=d(s.x,s.z);for(let e=0;e<Math.max(1,Math.round(3*t));e++)this.sand.emit({x:s.x+g(-.2,.2),y:r+.15,z:s.z+g(-.2,.2),vx:g(-.6,.6),vy:g(.3,1.1),vz:g(-.6,.6),life:g(1.2,1.9),size:g(.28,.55),alpha:.22,grow:.9,color:this.dust,gravity:-.3,drag:1.5})}}wisps(e,t){if(!this.reduced)for(this.wispCarry+=10*this.budget*e;this.wispCarry>=1;){this.wispCarry-=1;let e=Math.random()*Math.PI*2,i=24*Math.sqrt(Math.random()),s=t.x+Math.cos(e)*i,r=t.z+Math.sin(e)*i,a=g(2.2,3.6);this.sand.emit({x:s,y:d(s,r)+g(.2,1.4),z:r,vx:.82*a,vy:.1,vz:.57*a,life:g(3.5,6),size:g(.22,.55),alpha:g(.05,.11),grow:.5,color:this.dust})}}impact(e){let t=this.budget*(this.reduced?.5:1),i=d(e.x,e.z);for(let s=0;s<Math.round(150*t);s++){let t=Math.random()*Math.PI*2,s=g(2,7);this.sand.emit({x:e.x,y:i+.2,z:e.z,vx:Math.cos(t)*s,vy:g(2.5,6.5),vz:Math.sin(t)*s,life:g(.8,1.5),size:g(.16,.42),alpha:.95,color:this.chunk,gravity:8,drag:1.3})}for(let s=0;s<Math.round(48*t);s++){let t=s/48*Math.PI*2,r=g(3.5,5);this.sand.emit({x:e.x,y:i+.1,z:e.z,vx:Math.cos(t)*r,vy:g(.3,.9),vz:Math.sin(t)*r,life:g(.9,1.4),size:g(.3,.55),alpha:.55,grow:1.2,color:this.dust,drag:2.2})}this.flash.color.set("#ffc98a"),this.flash.position.set(e.x,i+1.2,e.z),this.flashLevel=70,this.flashDecay=3.5}sparkle(e,t){for(this.sparkleCarry+=14*this.budget*t;this.sparkleCarry>=1;){this.sparkleCarry-=1;let t=Math.random()*Math.PI*2,i=g(.35,.8);this.sparks.emit({x:e.x+Math.cos(t)*i,y:e.y+g(-.3,.2),z:e.z+Math.sin(t)*i,vx:0,vy:g(.4,.9),vz:0,life:g(.7,1.2),size:g(.05,.1),alpha:1,color:m,drag:.5})}}update(e){this.flashLevel*=Math.exp(-e*this.flashDecay),this.flash.intensity=this.flashLevel<.05?0:this.flashLevel,this.sand.update(e),this.sparks.update(e)}clear(){this.flashLevel=0,this.flash.intensity=0,this.sand.clear(),this.sparks.clear()}}var w=e.i(99209);let x=`
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`,y=`
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSunSize;
uniform float uStars;
uniform float uTime;
varying vec3 vDir;
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(smoothstep(0.0, 1.0, h), 0.55));
  col = mix(col, uHorizon * 0.85, smoothstep(0.0, -0.25, h));
  float c = dot(d, normalize(uSunDir));
  float disc = smoothstep(cos(uSunSize * 1.08), cos(uSunSize * 0.92), c);
  float glow = pow(max(c, 0.0), 12.0) * 0.3 + pow(max(c, 0.0), 90.0) * 0.45;
  // Faint maria on the moon (stars > 0); the sun keeps a clean disc.
  float maria = mix(1.0, 0.72 + 0.28 * hash31(floor(d * 900.0)) * smoothstep(0.0, 1.0, sin(d.x * 310.0) * sin(d.z * 270.0) + 0.6), uStars);
  col += uSunColor * (disc * 2.2 * maria + glow);
  // Stars: one jittered, round point per occupied cell, in two layers of different density.
  float stars = 0.0;
  for (int layer = 0; layer < 2; layer++) {
    float scale = layer == 0 ? 190.0 : 420.0;
    vec3 q = d * scale;
    vec3 cell = floor(q);
    float s = hash31(cell);
    vec3 jitter = vec3(hash31(cell + 1.7), hash31(cell + 4.1), hash31(cell + 9.3)) - 0.5;
    float r = length(fract(q) - 0.5 - jitter * 0.5);
    float lit = step(layer == 0 ? 0.972 : 0.955, s);
    float bright = layer == 0 ? 0.6 + 1.4 * fract(s * 37.0) : 0.35 + 0.5 * fract(s * 53.0);
    float twinkle = 0.75 + 0.25 * sin(uTime * (1.0 + 2.0 * fract(s * 11.0)) + s * 80.0);
    stars += lit * bright * twinkle * (1.0 - smoothstep(0.0, 0.22, r));
  }
  // A faint band of milky light across the sky.
  vec3 bandAxis = normalize(vec3(0.35, 0.45, 0.82));
  float band = exp(-pow(dot(d, bandAxis) * 3.2, 2.0)) * (0.55 + 0.45 * hash31(floor(d * 60.0)));
  float horizonFade = smoothstep(0.0, 0.1, h);
  col += (vec3(1.2, 1.2, 1.35) * stars + vec3(0.05, 0.06, 0.1) * band) * horizonFade * uStars;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;function M(e){let i=new t.IcosahedronGeometry(1,2),s=i.getAttribute("position"),r=new Float32Array(3*s.count),a=new t.Color("#96603a"),o=new t.Color("#cf9563"),n=new t.Color;for(let t=0;t<s.count;t++){let i=s.getX(t),l=s.getY(t),h=s.getZ(t),u=1+.24*Math.sin(3.1*i+e)*Math.sin(2.7*l+1.3*e)*Math.sin(2.9*h+.7*e)+.08*Math.sin(7.3*i+5.1*h+2.1*e);i*=u,l*=.72*u,h*=u,l<-.3&&(l=-.3+(l+.3)*.3),s.setXYZ(t,i,l,h),n.lerpColors(a,o,.5+.5*Math.sin(9*l+e)),r[3*t]=n.r,r[3*t+1]=n.g,r[3*t+2]=n.b}return i.setAttribute("color",new t.BufferAttribute(r,3)),i.computeVertexNormals(),i}class b{group=new t.Group;items=new Map;normalLight=new t.PointLight("#ff4a6e",0,4.5,2);goldenLight=new t.PointLight("#ffb52e",0,5.5,2);fruitGeo=new t.SphereGeometry(.34,32,24).scale(1,1.15,1);crownGeo=new t.CylinderGeometry(.09,.12,.07,12);gemGeo=new t.OctahedronGeometry(.46,0).scale(1,1.45,1);columnGeo=(function(){let e=new t.CylinderGeometry(.12,.42,3.2,20,1,!0).translate(0,1.6,0),i=e.getAttribute("position"),s=new Float32Array(3*i.count);for(let e=0;e<i.count;e++){let t=.35*Math.pow(1-i.getY(e)/3.2,2);s.set([+t,.62*t,.12*t],3*e)}return e.setAttribute("color",new t.BufferAttribute(s,3)),e})();ringGeo=new t.TorusGeometry(.62,.025,8,72);shadowGeo=new t.PlaneGeometry(1.25,1.25).rotateX(-Math.PI/2);normalMat=new t.MeshPhysicalMaterial({color:"#c71f4f",emissive:"#ff2f5f",emissiveIntensity:.9,roughness:.42,clearcoat:.7,clearcoatRoughness:.25,sheen:.4,sheenColor:new t.Color("#ff9fb4")});goldenMat=new t.MeshPhysicalMaterial({color:"#ff9a10",metalness:0,roughness:.15,emissive:"#ff7a00",emissiveIntensity:2.4,clearcoat:1,flatShading:!0});crownMat=new t.MeshStandardMaterial({color:"#9cc25a",roughness:.8});columnMat=new t.MeshBasicMaterial({vertexColors:!0,transparent:!0,blending:t.AdditiveBlending,depthWrite:!1,side:t.DoubleSide,fog:!1});ringMat=new t.MeshBasicMaterial({color:new t.Color(3.4,2.1,.35)});shadowTex=(function(){let e=document.createElement("canvas");e.width=e.height=64;let i=e.getContext("2d"),s=i.createRadialGradient(32,32,0,32,32,32);return s.addColorStop(0,"rgba(255,255,255,0.75)"),s.addColorStop(.45,"rgba(255,255,255,0.3)"),s.addColorStop(1,"rgba(255,255,255,0)"),i.fillStyle=s,i.fillRect(0,0,64,64),new t.CanvasTexture(e)})();shadowMat=new t.MeshBasicMaterial({color:0,alphaMap:this.shadowTex,transparent:!0,opacity:.14,depthWrite:!1,polygonOffset:!0,polygonOffsetFactor:-2});glow=1;reduced=!1;constructor(){this.group.add(this.normalLight,this.goldenLight)}sync(e,t,i){let s=new Set;for(let t of e)s.add(t.id),(this.items.get(t.id)??this.create(t,i)).food=t;for(let[e,t]of this.items)s.has(e)||(this.group.remove(t.group,t.shadow),this.items.delete(e));let r=!1,a=!1;for(let e of this.items.values()){var o;let s=e.food,n=d(s.pos.x,s.pos.z),l=this.reduced?1:1+2.70158*((o=Math.min(1,(i-e.born)/.4))-1)**3+1.70158*(o-1)**2,h=this.reduced?0:.12*Math.sin(2.4*i+s.id);e.group.position.set(s.pos.x,n+.55+h,s.pos.z),e.group.scale.setScalar(Math.max(.001,l)),e.fruit.rotation.y=this.reduced?0:.9*i,e.ring&&e.ring.rotation.set(.35*Math.sin(.8*i),1.4*i,0);let u=!(null!==s.expiresAt&&s.expiresAt-t<1.5)||Math.floor(i*(this.reduced?3:8))%2==0;e.group.visible=u,e.shadow.position.set(s.pos.x,n+.03,s.pos.z),e.shadow.scale.setScalar(Math.max(.001,l*(1-h)*("golden"===s.kind?.6:1)));let c="golden"===s.kind,f=c?this.goldenLight:this.normalLight;f.position.set(s.pos.x,n+.9,s.pos.z),f.intensity=(c?5:3.5)*this.glow*l*(u?1:.3)*(.85+.15*Math.sin(3*i+s.id)),c?a=!0:r=!0}r||(this.normalLight.intensity=0),a||(this.goldenLight.intensity=0)}setGlow(e){this.glow=e,this.normalMat.emissiveIntensity=.9*e,this.goldenMat.emissiveIntensity=2.4*e}setReducedMotion(e){this.reduced=e}clear(){for(let e of this.items.values())this.group.remove(e.group,e.shadow);this.items.clear()}dispose(){for(let e of(this.clear(),[this.fruitGeo,this.crownGeo,this.gemGeo,this.columnGeo,this.columnMat,this.ringGeo,this.shadowGeo,this.normalMat,this.goldenMat,this.crownMat,this.ringMat,this.shadowTex,this.shadowMat]))e.dispose()}create(e,i){let s=new t.Group,r="golden"===e.kind,a=new t.Mesh(r?this.gemGeo:this.fruitGeo,r?this.goldenMat:this.normalMat);if(!r){let e=new t.Mesh(this.crownGeo,this.crownMat);e.position.set(.1,.38,.05),e.rotation.set(.5,0,-.6),e.scale.set(1.3,1,.6),a.add(e)}s.add(a);let o=null;if("golden"===e.kind){o=new t.Mesh(this.ringGeo,this.ringMat),s.add(o);let e=new t.Mesh(this.columnGeo,this.columnMat);e.position.y=-.4,s.add(e)}let n=new t.Mesh(this.shadowGeo,this.shadowMat);this.group.add(s,n);let l={food:e,group:s,fruit:a,ring:o,shadow:n,born:i};return this.items.set(e.id,l),l}}let C=["skyZenith","skyHorizon","fog","sunColor","hemiSky","hemiGround","sandA","sandB","groove","rim","dust","rock","rockFill"],S=["fogDensity","sunIntensity","sunSize","stars","hemiIntensity","glint","foodGlow","bloom","exposure","snakeRim","snakeLift"],T={light:{skyZenith:new t.Color("#5b6fa6"),skyHorizon:new t.Color("#ffb07a"),fog:new t.Color("#eeb88f"),fogDensity:.011,sunDir:new t.Vector3(-.5,.25,-.83).normalize(),sunColor:new t.Color("#ffc88a"),sunIntensity:3.4,sunSize:.035,stars:0,hemiSky:new t.Color("#a9c3e8"),hemiGround:new t.Color("#d49a5e"),hemiIntensity:.7,sandA:new t.Color("#e7b67c"),sandB:new t.Color("#c8894f"),groove:new t.Color("#9c6538"),rim:new t.Color("#f2cd98"),dust:new t.Color("#e9c28f"),rock:new t.Color("#ffffff"),rockFill:new t.Color("#000000"),snakeRim:.08,snakeLift:1,glint:1,foodGlow:1,bloom:.32,exposure:1},dark:{skyZenith:new t.Color("#03060f"),skyHorizon:new t.Color("#16213d"),fog:new t.Color("#141c33"),fogDensity:.014,sunDir:new t.Vector3(-.62,.3,-.55).normalize(),sunColor:new t.Color("#b4c4ff"),sunIntensity:1.9,sunSize:.03,stars:1,hemiSky:new t.Color("#2b3a6b"),hemiGround:new t.Color("#2e2a26"),hemiIntensity:.6,sandA:new t.Color("#b3aa9c"),sandB:new t.Color("#857e74"),groove:new t.Color("#4d4a4a"),rim:new t.Color("#cdc6b8"),dust:new t.Color("#8e8a86"),rock:new t.Color("#a9b6e6"),rockFill:new t.Color("#10142a"),snakeRim:.4,snakeLift:1.6,glint:1.6,foodGlow:1.8,bloom:.55,exposure:1.1}};function A(e){let t={...e};for(let i of C)t[i]=e[i].clone();return t.sunDir=e.sunDir.clone(),t}function z(e,t,i,s){for(let r of C)s[r].lerpColors(e[r],t[r],i);for(let r of S)s[r]=e[r]+(t[r]-e[r])*i;return s.sunDir.lerpVectors(e.sunDir,t.sunDir,i).normalize(),s}let _=`
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.1, -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  vAlpha = aAlpha;
  vColor = aColor;
  #include <fog_vertex>
}
`,P=`
uniform vec3 uTint;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  gl_FragColor = vec4(vColor * uTint, smoothstep(0.5, 0.0, d) * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;class R{capacity;points;count;geometry;material;pos;col;size;alpha;vel;life;maxLife;baseSize;grow;baseAlpha;gravity;drag;constructor(e,s=!1){this.capacity=e,this.count=0,this.geometry=new t.BufferGeometry,this.pos=new Float32Array(3*e),this.col=new Float32Array(3*e),this.size=new Float32Array(e),this.alpha=new Float32Array(e),this.vel=new Float32Array(3*e),this.life=new Float32Array(e),this.maxLife=new Float32Array(e),this.baseSize=new Float32Array(e),this.grow=new Float32Array(e),this.baseAlpha=new Float32Array(e),this.gravity=new Float32Array(e),this.drag=new Float32Array(e),this.geometry.setAttribute("position",new t.BufferAttribute(this.pos,3).setUsage(t.DynamicDrawUsage)),this.geometry.setAttribute("aColor",new t.BufferAttribute(this.col,3).setUsage(t.DynamicDrawUsage)),this.geometry.setAttribute("aSize",new t.BufferAttribute(this.size,1).setUsage(t.DynamicDrawUsage)),this.geometry.setAttribute("aAlpha",new t.BufferAttribute(this.alpha,1).setUsage(t.DynamicDrawUsage)),this.geometry.setDrawRange(0,0),this.material=new t.ShaderMaterial({uniforms:t.UniformsUtils.merge([i.UniformsLib.fog,{uScale:{value:400},uTint:{value:new t.Color(1,1,1)}}]),vertexShader:_,fragmentShader:P,transparent:!0,depthWrite:!1,fog:!0,blending:s?t.AdditiveBlending:t.NormalBlending}),this.points=new t.Points(this.geometry,this.material),this.points.frustumCulled=!1}emit(e){if(this.count>=this.capacity)return;let t=this.count++;this.pos.set([e.x,e.y,e.z],3*t),this.vel.set([e.vx,e.vy,e.vz],3*t),this.col.set([e.color.r,e.color.g,e.color.b],3*t),this.life[t]=0,this.maxLife[t]=e.life,this.baseSize[t]=e.size,this.size[t]=0,this.grow[t]=e.grow??0,this.baseAlpha[t]=e.alpha,this.alpha[t]=0,this.gravity[t]=e.gravity??0,this.drag[t]=e.drag??0}update(e){let t=0;for(;t<this.count;){if(this.life[t]+=e,this.life[t]>=this.maxLife[t]){this.moveLastInto(t);continue}let i=3*t,s=Math.exp(-this.drag[t]*e);this.vel[i]*=s,this.vel[i+1]=(this.vel[i+1]-this.gravity[t]*e)*s,this.vel[i+2]*=s,this.pos[i]+=this.vel[i]*e,this.pos[i+1]+=this.vel[i+1]*e,this.pos[i+2]+=this.vel[i+2]*e;let r=this.life[t]/this.maxLife[t];this.size[t]=this.baseSize[t]*(1+this.grow[t]*r),this.alpha[t]=this.baseAlpha[t]*Math.min(1,6*r)*(1-r)**1.5,t++}for(let e of["position","aColor","aSize","aAlpha"])this.geometry.getAttribute(e).needsUpdate=!0;this.geometry.setDrawRange(0,this.count)}setScale(e,t){this.material.uniforms.uScale.value=e/(2*Math.tan(t*Math.PI/360))}setTint(e){this.material.uniforms.uTint.value.copy(e)}clear(){this.count=0,this.geometry.setDrawRange(0,0)}dispose(){this.geometry.dispose(),this.material.dispose()}moveLastInto(e){let t=--this.count;if(e!==t)for(let i of(this.pos.copyWithin(3*e,3*t,3*t+3),this.vel.copyWithin(3*e,3*t,3*t+3),this.col.copyWithin(3*e,3*t,3*t+3),[this.size,this.alpha,this.life,this.maxLife,this.baseSize,this.grow,this.baseAlpha,this.gravity,this.drag]))i[e]=i[t]}}let D={name:"CopyShader",uniforms:{tDiffuse:{value:null},opacity:{value:1}},vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		uniform float opacity;

		uniform sampler2D tDiffuse;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );
			gl_FragColor = opacity * texel;


		}`};var B=t;class k{constructor(){this.isPass=!0,this.enabled=!0,this.needsSwap=!0,this.clear=!1,this.renderToScreen=!1}setSize(){}render(){console.error("THREE.Pass: .render() must be implemented in derived pass.")}dispose(){}}let F=new B.OrthographicCamera(-1,1,1,-1,0,1);class U extends B.BufferGeometry{constructor(){super(),this.setAttribute("position",new B.Float32BufferAttribute([-1,3,0,-1,-1,0,3,-1,0],3)),this.setAttribute("uv",new B.Float32BufferAttribute([0,2,0,0,2,0],2))}}let G=new U;class L{constructor(e){this._mesh=new B.Mesh(G,e)}dispose(){this._mesh.geometry.dispose()}render(e){e.render(this._mesh,F)}get material(){return this._mesh.material}set material(e){this._mesh.material=e}}class E extends k{constructor(e,i="tDiffuse"){super(),this.textureID=i,this.uniforms=null,this.material=null,e instanceof t.ShaderMaterial?(this.uniforms=e.uniforms,this.material=e):e&&(this.uniforms=t.UniformsUtils.clone(e.uniforms),this.material=new t.ShaderMaterial({name:void 0!==e.name?e.name:"unspecified",defines:Object.assign({},e.defines),uniforms:this.uniforms,vertexShader:e.vertexShader,fragmentShader:e.fragmentShader})),this._fsQuad=new L(this.material)}render(e,t,i){this.uniforms[this.textureID]&&(this.uniforms[this.textureID].value=i.texture),this._fsQuad.material=this.material,this.renderToScreen?e.setRenderTarget(null):(e.setRenderTarget(t),this.clear&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil)),this._fsQuad.render(e)}dispose(){this.material.dispose(),this._fsQuad.dispose()}}class I extends k{constructor(e,t){super(),this.scene=e,this.camera=t,this.clear=!0,this.needsSwap=!1,this.inverse=!1}render(e,t,i){let s,r,a=e.getContext(),o=e.state;o.buffers.color.setMask(!1),o.buffers.depth.setMask(!1),o.buffers.color.setLocked(!0),o.buffers.depth.setLocked(!0),this.inverse?(s=0,r=1):(s=1,r=0),o.buffers.stencil.setTest(!0),o.buffers.stencil.setOp(a.REPLACE,a.REPLACE,a.REPLACE),o.buffers.stencil.setFunc(a.ALWAYS,s,0xffffffff),o.buffers.stencil.setClear(r),o.buffers.stencil.setLocked(!0),e.setRenderTarget(i),this.clear&&e.clear(),e.render(this.scene,this.camera),e.setRenderTarget(t),this.clear&&e.clear(),e.render(this.scene,this.camera),o.buffers.color.setLocked(!1),o.buffers.depth.setLocked(!1),o.buffers.color.setMask(!0),o.buffers.depth.setMask(!0),o.buffers.stencil.setLocked(!1),o.buffers.stencil.setFunc(a.EQUAL,1,0xffffffff),o.buffers.stencil.setOp(a.KEEP,a.KEEP,a.KEEP),o.buffers.stencil.setLocked(!0)}}class N extends k{constructor(){super(),this.needsSwap=!1}render(e){e.state.buffers.stencil.setLocked(!1),e.state.buffers.stencil.setTest(!1)}}class V{constructor(e,i){if(this.renderer=e,this._pixelRatio=e.getPixelRatio(),void 0===i){const s=e.getSize(new t.Vector2);this._width=s.width,this._height=s.height,(i=new t.WebGLRenderTarget(this._width*this._pixelRatio,this._height*this._pixelRatio,{type:t.HalfFloatType})).texture.name="EffectComposer.rt1"}else this._width=i.width,this._height=i.height;this.renderTarget1=i,this.renderTarget2=i.clone(),this.renderTarget2.texture.name="EffectComposer.rt2",this.writeBuffer=this.renderTarget1,this.readBuffer=this.renderTarget2,this.renderToScreen=!0,this.passes=[],this.copyPass=new E(D),this.copyPass.material.blending=t.NoBlending,this.timer=new t.Timer}swapBuffers(){let e=this.readBuffer;this.readBuffer=this.writeBuffer,this.writeBuffer=e}addPass(e){this.passes.push(e),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}insertPass(e,t){this.passes.splice(t,0,e),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}removePass(e){let t=this.passes.indexOf(e);-1!==t&&this.passes.splice(t,1)}isLastEnabledPass(e){for(let t=e+1;t<this.passes.length;t++)if(this.passes[t].enabled)return!1;return!0}render(e){this.timer.update(),void 0===e&&(e=this.timer.getDelta());let t=this.renderer.getRenderTarget(),i=!1;for(let t=0,s=this.passes.length;t<s;t++){let s=this.passes[t];if(!1!==s.enabled){if(s.renderToScreen=this.renderToScreen&&this.isLastEnabledPass(t),s.render(this.renderer,this.writeBuffer,this.readBuffer,e,i),s.needsSwap){if(i){let t=this.renderer.getContext(),i=this.renderer.state.buffers.stencil;i.setFunc(t.NOTEQUAL,1,0xffffffff),this.copyPass.render(this.renderer,this.writeBuffer,this.readBuffer,e),i.setFunc(t.EQUAL,1,0xffffffff)}this.swapBuffers()}void 0!==I&&(s instanceof I?i=!0:s instanceof N&&(i=!1))}}this.renderer.setRenderTarget(t)}reset(e){if(void 0===e){let i=this.renderer.getSize(new t.Vector2);this._pixelRatio=this.renderer.getPixelRatio(),this._width=i.width,this._height=i.height,(e=this.renderTarget1.clone()).setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}this.renderTarget1.dispose(),this.renderTarget2.dispose(),this.renderTarget1=e,this.renderTarget2=e.clone(),this.writeBuffer=this.renderTarget1,this.readBuffer=this.renderTarget2}setSize(e,t){this._width=e,this._height=t;let i=this._width*this._pixelRatio,s=this._height*this._pixelRatio;this.renderTarget1.setSize(i,s),this.renderTarget2.setSize(i,s);for(let e=0;e<this.passes.length;e++)this.passes[e].setSize(i,s)}setPixelRatio(e){this._pixelRatio=e,this.setSize(this._width,this._height)}dispose(){this.renderTarget1.dispose(),this.renderTarget2.dispose(),this.copyPass.dispose()}}let H={name:"OutputShader",uniforms:{tDiffuse:{value:null},toneMappingExposure:{value:1}},vertexShader:`
		precision highp float;

		uniform mat4 modelViewMatrix;
		uniform mat4 projectionMatrix;

		attribute vec3 position;
		attribute vec2 uv;

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		precision highp float;

		uniform sampler2D tDiffuse;

		#include <tonemapping_pars_fragment>
		#include <colorspace_pars_fragment>

		varying vec2 vUv;

		void main() {

			gl_FragColor = texture2D( tDiffuse, vUv );

			// tone mapping

			#ifdef LINEAR_TONE_MAPPING

				gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );

			#elif defined( REINHARD_TONE_MAPPING )

				gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );

			#elif defined( CINEON_TONE_MAPPING )

				gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );

			#elif defined( ACES_FILMIC_TONE_MAPPING )

				gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );

			#elif defined( AGX_TONE_MAPPING )

				gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );

			#elif defined( NEUTRAL_TONE_MAPPING )

				gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );

			#elif defined( CUSTOM_TONE_MAPPING )

				gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );

			#endif

			// color space

			#ifdef SRGB_TRANSFER

				gl_FragColor = sRGBTransferOETF( gl_FragColor );

			#endif

		}`};class O extends k{constructor(){super(),this.isOutputPass=!0,this.uniforms=t.UniformsUtils.clone(H.uniforms),this.material=new t.RawShaderMaterial({name:H.name,uniforms:this.uniforms,vertexShader:H.vertexShader,fragmentShader:H.fragmentShader}),this._fsQuad=new L(this.material),this._outputColorSpace=null,this._toneMapping=null}render(e,i,s){this.uniforms.tDiffuse.value=s.texture,this.uniforms.toneMappingExposure.value=e.toneMappingExposure,(this._outputColorSpace!==e.outputColorSpace||this._toneMapping!==e.toneMapping)&&(this._outputColorSpace=e.outputColorSpace,this._toneMapping=e.toneMapping,this.material.defines={},t.ColorManagement.getTransfer(this._outputColorSpace)===t.SRGBTransfer&&(this.material.defines.SRGB_TRANSFER=""),this._toneMapping===t.LinearToneMapping?this.material.defines.LINEAR_TONE_MAPPING="":this._toneMapping===t.ReinhardToneMapping?this.material.defines.REINHARD_TONE_MAPPING="":this._toneMapping===t.CineonToneMapping?this.material.defines.CINEON_TONE_MAPPING="":this._toneMapping===t.ACESFilmicToneMapping?this.material.defines.ACES_FILMIC_TONE_MAPPING="":this._toneMapping===t.AgXToneMapping?this.material.defines.AGX_TONE_MAPPING="":this._toneMapping===t.NeutralToneMapping?this.material.defines.NEUTRAL_TONE_MAPPING="":this._toneMapping===t.CustomToneMapping&&(this.material.defines.CUSTOM_TONE_MAPPING=""),this.material.needsUpdate=!0),!0===this.renderToScreen?e.setRenderTarget(null):(e.setRenderTarget(i),this.clear&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil)),this._fsQuad.render(e)}dispose(){this.material.dispose(),this._fsQuad.dispose()}}class W extends k{constructor(e,i,s=null,r=null,a=null){super(),this.scene=e,this.camera=i,this.overrideMaterial=s,this.clearColor=r,this.clearAlpha=a,this.clear=!0,this.clearDepth=!1,this.needsSwap=!1,this.isRenderPass=!0,this._oldClearColor=new t.Color}render(e,t,i){let s,r,a=e.autoClear;e.autoClear=!1,null!==this.overrideMaterial&&(r=this.scene.overrideMaterial,this.scene.overrideMaterial=this.overrideMaterial),null!==this.clearColor&&(e.getClearColor(this._oldClearColor),e.setClearColor(this.clearColor,e.getClearAlpha())),null!==this.clearAlpha&&(s=e.getClearAlpha(),e.setClearAlpha(this.clearAlpha)),!0==this.clearDepth&&e.clearDepth(),e.setRenderTarget(this.renderToScreen?null:i),!0===this.clear&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),e.render(this.scene,this.camera),null!==this.clearColor&&e.setClearColor(this._oldClearColor),null!==this.clearAlpha&&e.setClearAlpha(s),null!==this.overrideMaterial&&(this.scene.overrideMaterial=r),e.autoClear=a}}let X={name:"LuminosityHighPassShader",uniforms:{tDiffuse:{value:null},luminosityThreshold:{value:1},smoothWidth:{value:1},defaultColor:{value:new t.Color(0)},defaultOpacity:{value:0}},vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		uniform sampler2D tDiffuse;
		uniform vec3 defaultColor;
		uniform float defaultOpacity;
		uniform float luminosityThreshold;
		uniform float smoothWidth;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );

			float v = luminance( texel.xyz );

			vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity );

			float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );

			gl_FragColor = mix( outputColor, texel, alpha );

		}`};class Z extends k{constructor(e,i=1,s,r){super(),this.strength=i,this.radius=s,this.threshold=r,this.resolution=void 0!==e?new t.Vector2(e.x,e.y):new t.Vector2(256,256),this.clearColor=new t.Color(0,0,0),this.needsSwap=!1,this.renderTargetsHorizontal=[],this.renderTargetsVertical=[],this.nMips=5;let a=Math.round(this.resolution.x/2),o=Math.round(this.resolution.y/2);this.renderTargetBright=new t.WebGLRenderTarget(a,o,{type:t.HalfFloatType,depthBuffer:!1}),this.renderTargetBright.texture.name="UnrealBloomPass.bright",this.renderTargetBright.texture.generateMipmaps=!1;for(let e=0;e<this.nMips;e++){const i=new t.WebGLRenderTarget(a,o,{type:t.HalfFloatType,depthBuffer:!1});i.texture.name="UnrealBloomPass.h"+e,i.texture.generateMipmaps=!1,this.renderTargetsHorizontal.push(i);const s=new t.WebGLRenderTarget(a,o,{type:t.HalfFloatType,depthBuffer:!1});s.texture.name="UnrealBloomPass.v"+e,s.texture.generateMipmaps=!1,this.renderTargetsVertical.push(s),a=Math.round(a/2),o=Math.round(o/2)}this.highPassUniforms=t.UniformsUtils.clone(X.uniforms),this.highPassUniforms.luminosityThreshold.value=r,this.highPassUniforms.smoothWidth.value=.01,this.materialHighPassFilter=new t.ShaderMaterial({uniforms:this.highPassUniforms,vertexShader:X.vertexShader,fragmentShader:X.fragmentShader}),this.separableBlurMaterials=[];const n=[6,10,14,18,22];a=Math.round(this.resolution.x/2),o=Math.round(this.resolution.y/2);for(let e=0;e<this.nMips;e++)this.separableBlurMaterials.push(this._getSeparableBlurMaterial(n[e])),this.separableBlurMaterials[e].uniforms.invSize.value=new t.Vector2(1/a,1/o),a=Math.round(a/2),o=Math.round(o/2);this.compositeMaterial=this._getCompositeMaterial(this.nMips),this.compositeMaterial.uniforms.blurTexture1.value=this.renderTargetsVertical[0].texture,this.compositeMaterial.uniforms.blurTexture2.value=this.renderTargetsVertical[1].texture,this.compositeMaterial.uniforms.blurTexture3.value=this.renderTargetsVertical[2].texture,this.compositeMaterial.uniforms.blurTexture4.value=this.renderTargetsVertical[3].texture,this.compositeMaterial.uniforms.blurTexture5.value=this.renderTargetsVertical[4].texture,this.compositeMaterial.uniforms.bloomStrength.value=i,this.compositeMaterial.uniforms.bloomRadius.value=.1,this.compositeMaterial.uniforms.bloomFactors.value=[1,.8,.6,.4,.2],this.bloomTintColors=[new t.Vector3(1,1,1),new t.Vector3(1,1,1),new t.Vector3(1,1,1),new t.Vector3(1,1,1),new t.Vector3(1,1,1)],this.compositeMaterial.uniforms.bloomTintColors.value=this.bloomTintColors,this.copyUniforms=t.UniformsUtils.clone(D.uniforms),this.blendMaterial=new t.ShaderMaterial({uniforms:this.copyUniforms,vertexShader:D.vertexShader,fragmentShader:D.fragmentShader,premultipliedAlpha:!0,blending:t.AdditiveBlending,depthTest:!1,depthWrite:!1,transparent:!0}),this._oldClearColor=new t.Color,this._oldClearAlpha=1,this._basic=new t.MeshBasicMaterial,this._fsQuad=new L(null)}dispose(){for(let e=0;e<this.renderTargetsHorizontal.length;e++)this.renderTargetsHorizontal[e].dispose();for(let e=0;e<this.renderTargetsVertical.length;e++)this.renderTargetsVertical[e].dispose();this.renderTargetBright.dispose();for(let e=0;e<this.separableBlurMaterials.length;e++)this.separableBlurMaterials[e].dispose();this.compositeMaterial.dispose(),this.blendMaterial.dispose(),this._basic.dispose(),this._fsQuad.dispose()}setSize(e,i){let s=Math.round(e/2),r=Math.round(i/2);this.renderTargetBright.setSize(s,r);for(let e=0;e<this.nMips;e++)this.renderTargetsHorizontal[e].setSize(s,r),this.renderTargetsVertical[e].setSize(s,r),this.separableBlurMaterials[e].uniforms.invSize.value=new t.Vector2(1/s,1/r),s=Math.round(s/2),r=Math.round(r/2)}render(e,t,i,s,r){e.getClearColor(this._oldClearColor),this._oldClearAlpha=e.getClearAlpha();let a=e.autoClear;e.autoClear=!1,e.setClearColor(this.clearColor,0),r&&e.state.buffers.stencil.setTest(!1),this.renderToScreen&&(this._fsQuad.material=this._basic,this._basic.map=i.texture,e.setRenderTarget(null),e.clear(),this._fsQuad.render(e)),this.highPassUniforms.tDiffuse.value=i.texture,this.highPassUniforms.luminosityThreshold.value=this.threshold,this._fsQuad.material=this.materialHighPassFilter,e.setRenderTarget(this.renderTargetBright),e.clear(),this._fsQuad.render(e);let o=this.renderTargetBright;for(let t=0;t<this.nMips;t++)this._fsQuad.material=this.separableBlurMaterials[t],this.separableBlurMaterials[t].uniforms.colorTexture.value=o.texture,this.separableBlurMaterials[t].uniforms.direction.value=Z.BlurDirectionX,e.setRenderTarget(this.renderTargetsHorizontal[t]),e.clear(),this._fsQuad.render(e),this.separableBlurMaterials[t].uniforms.colorTexture.value=this.renderTargetsHorizontal[t].texture,this.separableBlurMaterials[t].uniforms.direction.value=Z.BlurDirectionY,e.setRenderTarget(this.renderTargetsVertical[t]),e.clear(),this._fsQuad.render(e),o=this.renderTargetsVertical[t];this._fsQuad.material=this.compositeMaterial,this.compositeMaterial.uniforms.bloomStrength.value=this.strength,this.compositeMaterial.uniforms.bloomRadius.value=this.radius,this.compositeMaterial.uniforms.bloomTintColors.value=this.bloomTintColors,e.setRenderTarget(this.renderTargetsHorizontal[0]),e.clear(),this._fsQuad.render(e),this._fsQuad.material=this.blendMaterial,this.copyUniforms.tDiffuse.value=this.renderTargetsHorizontal[0].texture,r&&e.state.buffers.stencil.setTest(!0),this.renderToScreen?e.setRenderTarget(null):e.setRenderTarget(i),this._fsQuad.render(e),e.setClearColor(this._oldClearColor,this._oldClearAlpha),e.autoClear=a}_getSeparableBlurMaterial(e){let i=[],s=e/3;for(let t=0;t<e;t++)i.push(.39894*Math.exp(-.5*t*t/(s*s))/s);let r=[],a=[];for(let t=1;t<e;t+=2){let s=i[t],o=t+1<e?i[t+1]:0,n=s+o;r.push((t*s+(t+1)*o)/n),a.push(n)}return new t.ShaderMaterial({defines:{KERNEL_PAIRS:r.length},uniforms:{colorTexture:{value:null},invSize:{value:new t.Vector2(.5,.5)},direction:{value:new t.Vector2(.5,.5)},centerWeight:{value:i[0]},gaussianOffsets:{value:r},gaussianWeights:{value:a}},vertexShader:`

				varying vec2 vUv;

				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}`,fragmentShader:`

				#include <common>

				varying vec2 vUv;

				uniform sampler2D colorTexture;
				uniform vec2 invSize;
				uniform vec2 direction;
				uniform float centerWeight;
				uniform float gaussianOffsets[KERNEL_PAIRS];
				uniform float gaussianWeights[KERNEL_PAIRS];

				void main() {

					vec3 diffuseSum = texture2D( colorTexture, vUv ).rgb * centerWeight;

					for ( int i = 0; i < KERNEL_PAIRS; i ++ ) {

						vec2 uvOffset = direction * invSize * gaussianOffsets[ i ];
						vec3 sample1 = texture2D( colorTexture, vUv + uvOffset ).rgb;
						vec3 sample2 = texture2D( colorTexture, vUv - uvOffset ).rgb;
						diffuseSum += ( sample1 + sample2 ) * gaussianWeights[ i ];

					}

					gl_FragColor = vec4( diffuseSum, 1.0 );

				}`})}_getCompositeMaterial(e){return new t.ShaderMaterial({defines:{NUM_MIPS:e},uniforms:{blurTexture1:{value:null},blurTexture2:{value:null},blurTexture3:{value:null},blurTexture4:{value:null},blurTexture5:{value:null},bloomStrength:{value:1},bloomFactors:{value:null},bloomTintColors:{value:null},bloomRadius:{value:0}},vertexShader:`

				varying vec2 vUv;

				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}`,fragmentShader:`

				varying vec2 vUv;

				uniform sampler2D blurTexture1;
				uniform sampler2D blurTexture2;
				uniform sampler2D blurTexture3;
				uniform sampler2D blurTexture4;
				uniform sampler2D blurTexture5;
				uniform float bloomStrength;
				uniform float bloomRadius;
				uniform float bloomFactors[NUM_MIPS];
				uniform vec3 bloomTintColors[NUM_MIPS];

				float lerpBloomFactor( const in float factor ) {

					float mirrorFactor = 1.2 - factor;
					return mix( factor, mirrorFactor, bloomRadius );

				}

				void main() {

					// 3.0 for backwards compatibility with previous alpha-based intensity
					vec3 bloom = 3.0 * bloomStrength * (
						lerpBloomFactor( bloomFactors[ 0 ] ) * bloomTintColors[ 0 ] * texture2D( blurTexture1, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 1 ] ) * bloomTintColors[ 1 ] * texture2D( blurTexture2, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 2 ] ) * bloomTintColors[ 2 ] * texture2D( blurTexture3, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 3 ] ) * bloomTintColors[ 3 ] * texture2D( blurTexture4, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 4 ] ) * bloomTintColors[ 4 ] * texture2D( blurTexture5, vUv ).rgb
					);

					float bloomAlpha = max( bloom.r, max( bloom.g, bloom.b ) );
					gl_FragColor = vec4( bloom, bloomAlpha );

				}`})}}Z.BlurDirectionX=new t.Vector2(1,0),Z.BlurDirectionY=new t.Vector2(0,1);class Q{renderer;scene;camera;composer;bloom;strength;constructor(e,t,i,s){this.renderer=e,this.scene=t,this.camera=i,this.composer=null,this.bloom=null,this.strength=.3,this.setQuality(s)}setQuality(e){if(this.composer?.dispose(),this.composer=null,this.bloom=null,"low"===e)return;let i=this.renderer.getDrawingBufferSize(new t.Vector2),s=new t.WebGLRenderTarget(i.x,i.y,{type:t.HalfFloatType,samples:4}),r=new V(this.renderer,s);r.addPass(new W(this.scene,this.camera)),this.bloom=new Z(new t.Vector2(i.x,i.y),this.strength,.55,.95),r.addPass(this.bloom),r.addPass(new O),this.composer=r}setSize(e,t){this.composer&&(this.composer.setPixelRatio(this.renderer.getPixelRatio()),this.composer.setSize(e,t))}setBloom(e){this.strength=e,this.bloom&&(this.bloom.strength=e)}render(){this.composer?this.composer.render():this.renderer.render(this.scene,this.camera)}dispose(){this.composer?.dispose()}}let j=1.3*h.BODY_R,$=`
float around = fract(vUv.y);
float top = 0.5 + 0.5 * sin(around * 6.2831853);
vec3 skin = mix(uBelly, uBase, smoothstep(0.18, 0.5, top));
// Dark saddles across the back, edged in a warm accent; they read even at play distance.
float bandPos = vUv.x * 1.15 + 0.18 * sin(vUv.x * 0.83) + 0.1 * sin(vUv.x * 2.9);
float band = abs(fract(bandPos) - 0.5);
float bandW = 0.15 + 0.06 * sin(floor(bandPos) * 2.7);
float dorsal = smoothstep(0.2, 0.6, top);
float saddle = (1.0 - smoothstep(bandW, bandW + 0.06, band)) * dorsal;
skin = mix(skin, uDark, saddle);
float edge = (1.0 - smoothstep(0.0, 0.035, abs(band - bandW - 0.03))) * dorsal;
skin = mix(skin, uAccent, edge * 0.85);
// Pale line where the flank meets the belly.
float flank = 1.0 - smoothstep(0.0, 0.05, abs(top - 0.22));
skin = mix(skin, uBelly * 1.1, flank * 0.6);
vec2 sc = vec2(vUv.x * 10.0, around * 28.0);
sc.x += 0.5 * mod(floor(sc.y), 2.0);
float cell = length(fract(sc) - 0.5);
skin *= 0.8 + 0.2 * (1.0 - smoothstep(0.22, 0.52, cell));
diffuseColor.rgb = skin;
`,Y=`
float rimF = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
totalEmissiveRadiance += uRimColor * rimF * uRim;
`,K=`
diffuseColor.rgb *= uLift;
float skinLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(skinLum) * vec3(1.05, 0.95, 0.85), uDead * 0.75);
`;function q(e,t){Object.assign(e.uniforms,t),e.fragmentShader=e.fragmentShader.replace("#include <common>","#include <common>\nuniform float uRim;\nuniform vec3 uRimColor;\nuniform float uLift;\nuniform float uDead;").replace("#include <color_fragment>",`#include <color_fragment>
${K}`).replace("#include <emissivemap_fragment>",`#include <emissivemap_fragment>
${Y}`)}class J{maxPoints;group;geometry;positions;normals;uvs;arcs;head;tongue;disposables;rim;swayPhase;tongueClock;constructor(e=1400){this.maxPoints=e,this.group=new t.Group,this.geometry=new t.BufferGeometry,this.head=new t.Group,this.tongue=new t.Group,this.disposables=[],this.rim={uRim:{value:.1},uRimColor:{value:new t.Color("#8fe0c0")},uLift:{value:1},uDead:{value:0}},this.swayPhase=0,this.tongueClock=0;const i=15*e;this.positions=new Float32Array(3*i),this.normals=new Float32Array(3*i),this.uvs=new Float32Array(2*i),this.arcs=new Float32Array(e);const s=new Uint32Array((e-1)*84);let r=0;for(let t=0;t<e-1;t++)for(let e=0;e<14;e++){const i=15*t+e,a=i+1,o=i+14+1,n=o+1;s[r++]=i,s[r++]=a,s[r++]=o,s[r++]=a,s[r++]=n,s[r++]=o}this.geometry.setAttribute("position",new t.BufferAttribute(this.positions,3).setUsage(t.DynamicDrawUsage)),this.geometry.setAttribute("normal",new t.BufferAttribute(this.normals,3).setUsage(t.DynamicDrawUsage)),this.geometry.setAttribute("uv",new t.BufferAttribute(this.uvs,2).setUsage(t.DynamicDrawUsage)),this.geometry.setIndex(new t.BufferAttribute(s,1)),this.geometry.setDrawRange(0,0);const a=function(e){let i=new t.MeshPhysicalMaterial({color:0xffffff,roughness:.55,metalness:0,clearcoat:.18,clearcoatRoughness:.5,iridescence:.12,iridescenceIOR:1.3,iridescenceThicknessRange:[180,420]});return i.defines={USE_UV:""},i.onBeforeCompile=i=>{i.uniforms.uBase={value:new t.Color("#4c9a3f")},i.uniforms.uDark={value:new t.Color("#173d24")},i.uniforms.uBelly={value:new t.Color("#ecdca6")},i.uniforms.uAccent={value:new t.Color("#e8b54a")},q(i,e),i.fragmentShader=i.fragmentShader.replace("#include <common>","#include <common>\nuniform vec3 uBase;\nuniform vec3 uDark;\nuniform vec3 uBelly;\nuniform vec3 uAccent;").replace("#include <color_fragment>",`#include <color_fragment>
${$}`)},i}(this.rim),o=new t.Mesh(this.geometry,a);o.castShadow=!0,o.receiveShadow=!0,o.frustumCulled=!1;const n=new t.MeshPhysicalMaterial({color:"#3f8636",roughness:.5,clearcoat:.2,clearcoatRoughness:.45,iridescence:.12,iridescenceIOR:1.3});n.onBeforeCompile=e=>q(e,this.rim);const l=function(){let e=new t.SphereGeometry(1,32,20),i=e.getAttribute("position");for(let e=0;e<i.count;e++){let t=i.getX(e),s=(t+1)/2,r=.46*(1-.45*s*s),a=.29*(1-.35*s)*(0>i.getY(e)?.8:1);i.setXYZ(e,.66*t+.08,i.getY(e)*a,i.getZ(e)*r)}return e.computeVertexNormals(),e}(),u=new t.Mesh(l,n);u.castShadow=!0;const d=new t.SphereGeometry(.085,16,12),c=new t.MeshPhysicalMaterial({color:"#f0b429",emissive:"#8a5a00",emissiveIntensity:.6,roughness:.15,clearcoat:1}),f=new t.SphereGeometry(1,12,8),p=new t.MeshStandardMaterial({color:"#050505",roughness:.2});for(const e of[-1,1]){const i=new t.Mesh(d,c);i.position.set(.2,.12,.3*e);const s=new t.Mesh(f,p);s.scale.set(.022,.06,.02),s.position.set(.035,0,.055*e),i.add(s),this.head.add(i)}const m=new t.MeshStandardMaterial({color:"#c3223c",roughness:.5}),g=new t.BoxGeometry(.22,.012,.012),v=new t.BoxGeometry(.09,.01,.01),w=new t.Mesh(g,m);for(const e of(w.position.x=.11,this.tongue.add(w),[-1,1])){const i=new t.Mesh(v,m);i.position.set(.25,0,.018*e),i.rotation.y=-.4*e,this.tongue.add(i)}this.tongue.position.set(.55,-.02,0),this.head.add(u,this.tongue),this.head.scale.setScalar(j/h.BODY_R),this.group.add(o,this.head),this.disposables.push(this.geometry,a,n,l,d,c,f,p,m,g,v)}update(e,t,i,s,a,o){let n=Math.min(e.length,this.maxPoints);if(n<2)return void this.geometry.setDrawRange(0,0);o&&(this.swayPhase+=i*s*1.6),this.rim.uDead.value=Math.min(1,2.5*a),this.arcs[0]=0;for(let t=1;t<n;t++)this.arcs[t]=this.arcs[t-1]+Math.hypot(e[t].x-e[t-1].x,e[t].z-e[t-1].z);let l=this.arcs[n-1]||1,h=.36*a;for(let t=0;t<n;t++){var u,c;let i=e[t],s=e[Math.max(0,t-1)],a=e[Math.min(n-1,t+1)],o=s.x-a.x,f=s.z-a.z,p=Math.hypot(o,f)||1;o/=p;let m=-(f/=p),g=o,v=this.arcs[t],w=(u=v,c=l,j*(.8+.2*(0,r.smoothstep)(0,.7,u))*(1-.82*(0,r.smoothstep)(.35*c,c,u))),x=.07*Math.sin(this.swayPhase-2.4*v)*(0,r.smoothstep)(.5,1.6,v),y=i.x+m*x,M=i.z+g*x,b=d(i.x,i.z)+.8*w-.05-h;for(let e=0;e<=14;e++){let i=e/14*Math.PI*2,s=Math.cos(i),r=Math.sin(i),a=15*t+e;this.positions[3*a]=y+m*s*w,this.positions[3*a+1]=b+r*w*.8,this.positions[3*a+2]=M+g*s*w;let o=m*s*.8,n=g*s*.8,l=Math.hypot(o,r,n)||1;this.normals[3*a]=o/l,this.normals[3*a+1]=r/l,this.normals[3*a+2]=n/l,this.uvs[2*a]=v,this.uvs[2*a+1]=e/14}}for(let e of["position","normal","uv"])this.geometry.getAttribute(e).needsUpdate=!0;this.geometry.setDrawRange(0,(n-1)*84);let f=e[0];this.head.position.set(f.x+.1*Math.cos(t),d(f.x,f.z)+.3-1.3*h,f.z+.1*Math.sin(t)),this.head.rotation.set(0,-t,0),this.tongueClock+=i;let p=this.tongueClock%2.8,m=p<.22?Math.sin(p/.22*Math.PI):0;this.tongue.visible=m>.01&&0===a,this.tongue.scale.set(Math.max(.001,m),1,1)}setRim(e,t=1){this.rim.uRim.value=e,this.rim.uLift.value=t}setVisible(e){this.group.visible=e}dispose(){for(let e of this.disposables)e.dispose()}}function ee(e){return 80*(.35*e+.65*e**5)}let et=`
#define GROOVE_DEPTH 0.140
#define RIM_HEIGHT 0.060
uniform sampler2D uTrail;
uniform float uTrailHalf;
vec4 sampleTrail(vec2 p) {
  vec2 uv = p / (2.0 * uTrailHalf) + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(uTrail, uv);
}
float trailH(vec2 p) {
  vec4 t = sampleTrail(p);
  return -t.r * GROOVE_DEPTH + t.g * RIM_HEIGHT;
}
`,ei=`
varying vec2 vXZ;
varying vec3 vWN;
varying vec3 vWPos;
${c}
${f}
${et}
`,es=`
vec2 pXZ = position.xz;
float hC = terrainHeight(pXZ);
float hX = terrainHeight(pXZ + vec2(0.3, 0.0));
float hZ = terrainHeight(pXZ + vec2(0.0, 0.3));
vec3 objectNormal = normalize(vec3(hC - hX, 0.3, hC - hZ));
vWN = objectNormal;
vXZ = pXZ;
`,er=`
vec3 transformed = vec3(position.x, hC + trailH(pXZ), position.z);
vWPos = transformed;
`,ea=`
uniform float uTrailTexel;
uniform vec3 uSandA;
uniform vec3 uSandB;
uniform vec3 uGroove;
uniform vec3 uRim;
uniform float uGlint;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uTime;
varying vec2 vXZ;
varying vec3 vWN;
varying vec3 vWPos;
${c}
${et}
`,eo=`
vec4 trailS = sampleTrail(vXZ);
float groove = trailS.r;
float rim = trailS.g;
float fresh = trailS.b;
float large = fbm(vXZ * 0.07);
float grain = vnoise(vXZ * 2.3);
vec3 sand = mix(uSandB, uSandA, smoothstep(0.3, 0.72, large));
sand *= 0.94 + 0.1 * grain;
sand = mix(sand, uGroove, clamp(groove * (0.45 + 0.4 * fresh), 0.0, 0.9));
sand = mix(sand, uRim, clamp(rim * 0.55, 0.0, 1.0));
diffuseColor.rgb *= sand;
`,en=`
// Ripple direction and wavelength drift over large scales so the field doesn't read as a texture.
float windA = 0.608 + (fbm(vXZ * 0.025) - 0.5) * 0.9;
vec2 windDir = vec2(cos(windA), sin(windA));
float rippleK = 7.2 * (0.82 + 0.36 * fbm(vXZ * 0.04 + 7.3));
float ripplePhase = dot(vXZ, windDir) * rippleK + fbm(vXZ * 0.33) * 6.0;
float rippleAA = clamp(1.0 - fwidth(ripplePhase) * 0.4, 0.0, 1.0);
float disturbed = clamp(groove * 1.6 + rim * 1.2, 0.0, 1.0);
float duneFade = 1.0 - 0.75 * smoothstep(${u.toFixed(1)}, ${(u+20).toFixed(1)}, length(vXZ));
float rippleAmp = 0.045 * rippleAA * (1.0 - disturbed) * duneFade * (0.55 + 0.9 * fbm(vXZ * 0.11));
float dRipple = cos(ripplePhase) + 0.35 * cos(2.0 * ripplePhase);
vec2 grad = windDir * dRipple * rippleK * rippleAmp * 0.8;
float te = uTrailTexel;
grad += 1.6 * vec2(
  trailH(vXZ + vec2(te, 0.0)) - trailH(vXZ - vec2(te, 0.0)),
  trailH(vXZ + vec2(0.0, te)) - trailH(vXZ - vec2(0.0, te))
) / (2.0 * te);
grad += (vec2(vnoise(vXZ * 11.0), vnoise(vXZ * 11.0 + 31.7)) - 0.5) * 0.1 * rippleAA;
vec3 sandN = normalize(normalize(vWN) + vec3(-grad.x, 0.0, -grad.y));
normal = normalize((viewMatrix * vec4(sandN, 0.0)).xyz);
`,el=`
float glintSeed = hash21(floor(vXZ * 34.0));
vec3 viewDirW = normalize(cameraPosition - vWPos);
vec3 halfW = normalize(viewDirW + normalize(uSunDir));
float glintSpec = pow(max(dot(sandN, halfW), 0.0), 90.0);
float twinkle = 0.55 + 0.45 * sin(uTime * 2.3 + glintSeed * 71.0);
float glintFade = 1.0 - smoothstep(18.0, 45.0, length(cameraPosition - vWPos));
float crest = smoothstep(0.45, 0.95, sin(ripplePhase));
totalEmissiveRadiance += uSunColor * step(0.996, glintSeed) * crest * glintSpec * twinkle * glintFade * uGlint * 1.6 * (1.0 - groove);
`,eh=`
attribute vec2 aPerp;
attribute float aSide;
attribute float aBirth;
uniform float uClock;
uniform float uHalfExtent;
uniform float uHold;
uniform float uLife;
uniform float uRibbonHalf;
varying float vAcross;
varying float vShape;
float shapeOf(float age) {
  if (age <= uHold) return 1.0;
  float t = clamp((age - uHold) / (uLife - uHold), 0.0, 1.0);
  return 1.0 - t * t * (3.0 - 2.0 * t);
}
void main() {
  float s = shapeOf(uClock - aBirth);
  vShape = s;
  vAcross = aSide;
  vec2 p = position.xz + aPerp * aSide * uRibbonHalf * s;
  gl_Position = vec4(p / uHalfExtent, 0.0, 1.0);
}
`,eu=`
varying float vAcross;
varying float vShape;
void main() {
  float u = abs(vAcross);
  float core = max(0.0, 1.0 - (u / 0.5) * (u / 0.5));
  float groove = pow(core, 0.8);
  float rim = smoothstep(0.35, 0.55, u) * (1.0 - smoothstep(0.62, 1.0, u));
  // Depth and rims fade faster than the width narrows, so an old groove reads as shallow and soft.
  float depth = pow(vShape, 1.4);
  gl_FragColor = vec4(groove * depth, rim * depth, vShape * (1.0 - u), 1.0);
}
`;class ed{texel;target;points=[];scene=new t.Scene;camera=new t.Camera;geometry=new t.BufferGeometry;material;position;perp;side;birth;clearColor=new t.Color;constructor(e){this.target=new t.WebGLRenderTarget(e,e,{type:t.HalfFloatType,format:t.RGBAFormat,minFilter:t.LinearFilter,magFilter:t.LinearFilter,depthBuffer:!1,generateMipmaps:!1}),this.texel=52/e;this.position=new t.BufferAttribute(new Float32Array(9600),3).setUsage(t.DynamicDrawUsage),this.perp=new t.BufferAttribute(new Float32Array(6400),2).setUsage(t.DynamicDrawUsage),this.side=new t.BufferAttribute(new Float32Array(3200),1),this.birth=new t.BufferAttribute(new Float32Array(3200),1).setUsage(t.DynamicDrawUsage);for(let e=0;e<3200;e++)this.side.setX(e,e%2==0?-1:1);const i=new Uint32Array(9594);for(let e=0;e<1599;e++){const t=2*e;i.set([t,t+1,t+2,t+1,t+3,t+2],6*e)}this.geometry.setAttribute("position",this.position),this.geometry.setAttribute("aPerp",this.perp),this.geometry.setAttribute("aSide",this.side),this.geometry.setAttribute("aBirth",this.birth),this.geometry.setIndex(new t.BufferAttribute(i,1)),this.geometry.setDrawRange(0,0),this.material=new t.ShaderMaterial({vertexShader:eh,fragmentShader:eu,uniforms:{uClock:{value:0},uHalfExtent:{value:26},uHold:{value:4},uLife:{value:10},uRibbonHalf:{value:1}},blending:t.CustomBlending,blendEquation:t.MaxEquation,blendSrc:t.OneFactor,blendDst:t.OneFactor,depthTest:!1,depthWrite:!1,transparent:!0,side:t.DoubleSide});const s=new t.Mesh(this.geometry,this.material);s.frustumCulled=!1,this.scene.add(s)}get texture(){return this.target.texture}push(e,t,i){let s=this.points[this.points.length-1];s&&(s.x-e)**2+(s.z-t)**2<.1*.1||(this.points.push({x:e,z:t,birth:i}),this.points.length>1600&&this.points.shift())}clear(){this.points.length=0}render(e,t){let i=0;for(;i<this.points.length&&t-this.points[i].birth>=10;)i++;i>0&&this.points.splice(0,i),this.rebuild(),this.material.uniforms.uClock.value=t;let s=e.getRenderTarget();e.getClearColor(this.clearColor);let r=e.getClearAlpha();e.setRenderTarget(this.target),e.setClearColor(0,0),e.clear(!0,!1,!1),this.points.length>1&&e.render(this.scene,this.camera),e.setRenderTarget(s),e.setClearColor(this.clearColor,r)}dispose(){this.target.dispose(),this.geometry.dispose(),this.material.dispose()}rebuild(){let e=this.points,t=e.length;for(let i=0;i<t;i++){let s=e[Math.max(0,i-1)],r=e[Math.min(t-1,i+1)],a=r.x-s.x,o=r.z-s.z,n=Math.hypot(a,o)||1;a/=n,o/=n;for(let t=0;t<2;t++){let s=2*i+t;this.position.setXYZ(s,e[i].x,0,e[i].z),this.perp.setXY(s,-o,a),this.birth.setX(s,e[i].birth)}}this.position.needsUpdate=!0,this.perp.needsUpdate=!0,this.birth.needsUpdate=!0,this.geometry.setDrawRange(0,6*Math.max(0,t-1))}}e.s(["mount",0,function(e,o){var n,u;let c,f,p,m,g,C,S,_,P,D,B,k,F,U=new i.WebGLRenderer({canvas:e,antialias:!0,powerPreference:"high-performance"}),G=o.quality??(c=window.matchMedia("(pointer: coarse)").matches,f=navigator.hardwareConcurrency??4,c||f<=4?"low":"high");U.setPixelRatio(Math.min(window.devicePixelRatio,"high"===G?2:1.5)),U.shadowMap.enabled=!0,U.shadowMap.type=t.PCFShadowMap,U.toneMapping=t.ACESFilmicToneMapping,U.outputColorSpace=t.SRGBColorSpace;let L=new t.Scene,E=new ed("high"===G?1024:512),I=(p={uTrail:{value:(n={segments:"high"===G?400:240,trailTexture:E.texture,trailTexel:E.texel}).trailTexture},uTrailHalf:{value:26},uTrailTexel:{value:n.trailTexel},uSandA:{value:new t.Color},uSandB:{value:new t.Color},uGroove:{value:new t.Color},uRim:{value:new t.Color},uGlint:{value:1},uSunDir:{value:new t.Vector3(0,1,0)},uSunColor:{value:new t.Color},uTime:{value:0}},(m=new t.MeshStandardMaterial({color:0xffffff,roughness:.93,metalness:0})).onBeforeCompile=e=>{Object.assign(e.uniforms,p),e.vertexShader=e.vertexShader.replace("#include <common>",`#include <common>
${ei}`).replace("#include <beginnormal_vertex>",es).replace("#include <begin_vertex>",er),e.fragmentShader=e.fragmentShader.replace("#include <common>",`#include <common>
${ea}`).replace("#include <color_fragment>",`#include <color_fragment>
${eo}`).replace("#include <normal_fragment_maps>",`#include <normal_fragment_maps>
${en}`).replace("#include <emissivemap_fragment>",`#include <emissivemap_fragment>
${el}`)},(g=new t.Mesh(function(e){let i=e+1,s=new Float32Array(i*i*3),r=new Float32Array(i*i*3);for(let t=0;t<i;t++){let a=ee(t/e*2-1);for(let o=0;o<i;o++){let n=(t*i+o)*3;s[n]=ee(o/e*2-1),s[n+2]=a,r[n+1]=1}}let a=new Uint32Array(e*e*6),o=0;for(let t=0;t<e;t++)for(let s=0;s<e;s++){let e=t*i+s,r=e+1,n=e+i,l=n+1;a[o++]=e,a[o++]=n,a[o++]=r,a[o++]=r,a[o++]=n,a[o++]=l}let n=new t.BufferGeometry;return n.setAttribute("position",new t.BufferAttribute(s,3)),n.setAttribute("normal",new t.BufferAttribute(r,3)),n.setIndex(new t.BufferAttribute(a,1)),n.boundingSphere=new t.Sphere(new t.Vector3,120),n}(n.segments),m)).receiveShadow=!0,g.frustumCulled=!1,{mesh:g,setPalette(e){p.uSandA.value.copy(e.sandA),p.uSandB.value.copy(e.sandB),p.uGroove.value.copy(e.groove),p.uRim.value.copy(e.rim),p.uGlint.value=e.glint,p.uSunDir.value.copy(e.sunDir),p.uSunColor.value.copy(e.sunColor).multiplyScalar(e.sunIntensity/3)},setTime(e){p.uTime.value=e},dispose(){g.geometry.dispose(),m.dispose()}});L.add(I.mesh);let N=(u={shadowSize:"high"===G?2048:1024},(C=new t.DirectionalLight(0xffffff,3)).castShadow=!0,C.shadow.mapSize.set(u.shadowSize,u.shadowSize),(S=C.shadow.camera).left=-28,S.right=28,S.top=28,S.bottom=-28,S.near=1,S.far=160,C.shadow.bias=-4e-4,C.shadow.normalBias=.035,C.shadow.radius=3,L.add(C,C.target),_=new t.HemisphereLight(0xffffff,0,.6),L.add(_),P={uZenith:{value:new t.Color},uHorizon:{value:new t.Color},uSunColor:{value:new t.Color},uSunDir:{value:new t.Vector3(0,1,0)},uSunSize:{value:.03},uStars:{value:0},uTime:{value:0}},D=new t.ShaderMaterial({uniforms:P,vertexShader:x,fragmentShader:y,side:t.BackSide,depthWrite:!1,fog:!1}),(B=new t.Mesh(new t.SphereGeometry(500,48,24),D)).renderOrder=-1,B.frustumCulled=!1,L.add(B),L.fog=k=new t.FogExp2(0xffffff,.01),F=function(){let e=new t.Group,i=new t.MeshStandardMaterial({vertexColors:!0,roughness:.92,metalness:0}),s=[1.7,4.2,8.9].map(M),a=Math.ceil(51/s.length),o=s.map(s=>{let r=new t.InstancedMesh(s,i,a);return r.castShadow=!0,r.receiveShadow=!0,e.add(r),r}),n=1337,l=()=>{let e=(0,w.nextRandom)(n);return n=e.seed,e.value},u=new t.Matrix4,c=new t.Quaternion,f=new t.Vector3,p=new t.Vector3,m=new t.Vector3,g=o.map(()=>0);for(let e=0;e<51;e++){let i=.18>l()?1.6+ +l():.6+.8*l();f.set(i*(.8+.5*l()),i*(.6+.5*l()),i*(.8+.5*l()));let s=e/51*r.TAU+(l()-.5)*.08,a=h.ARENA_R-.2+1.1*Math.max(f.x,f.z)+.8*l(),n=Math.cos(s)*a,v=Math.sin(s)*a;p.set(n,d(n,v)-.25*f.y,v),m.set((l()-.5)*.3,l()*r.TAU,(l()-.5)*.3),c.setFromAxisAngle(new t.Vector3(0,1,0),m.y).multiply(new t.Quaternion().setFromAxisAngle(new t.Vector3(1,0,0),m.x)),u.compose(p,c,f);let w=e%o.length;o[w].setMatrixAt(g[w]++,u)}return o.forEach((e,t)=>{e.count=g[t],e.instanceMatrix.needsUpdate=!0}),{group:e,material:i,dispose(){s.forEach(e=>e.dispose()),i.dispose()}}}(),L.add(F.group),{sun:C,setPalette(e){P.uZenith.value.copy(e.skyZenith),P.uHorizon.value.copy(e.skyHorizon),P.uSunColor.value.copy(e.sunColor);let t=Math.atan2(e.sunDir.z,e.sunDir.x)-Math.PI/2+.32,i=9.5*Math.PI/180;P.uSunDir.value.set(Math.cos(t)*Math.cos(i),Math.sin(i),Math.sin(t)*Math.cos(i)),P.uSunSize.value=e.sunSize,P.uStars.value=e.stars,C.color.copy(e.sunColor),C.intensity=e.sunIntensity,C.position.copy(e.sunDir).multiplyScalar(80),_.color.copy(e.hemiSky),_.groundColor.copy(e.hemiGround),_.intensity=e.hemiIntensity,k.color.copy(e.fog),k.density=e.fogDensity,F.material.color.copy(e.rock),F.material.emissive.copy(e.rockFill)},update(e,t){P.uTime.value=e,B.position.copy(t)},setShadowSize(e){C.shadow.mapSize.set(e,e),C.shadow.map?.dispose(),C.shadow.map=null},dispose(){B.geometry.dispose(),D.dispose(),F.dispose(),C.shadow.map?.dispose()}}),V=new J;L.add(V.group);let H=new b;L.add(H.group);let O=new R("high"===G?2500:1200),W=new R(400,!0);L.add(O.points,W.points);let X=new v(O,W);X.setBudget("high"===G?1:.5),L.add(X.flash);let Z=new l,j=new Q(U,L,Z.camera,G),$=o.theme,Y=A(T[$]),K=null,q=1,et=o.reducedMotion,eh=0,eu=0,ec=null,ef=1/60,ep=0,em=[],eg=new t.Vector3;function ev(){N.setPalette(Y),I.setPalette(Y),j.setBloom(Y.bloom),U.toneMappingExposure=Y.exposure,H.setGlow(Y.foodGlow),X.setDust(Y.dust),X.setChunk(Y.rim),V.setRim(Y.snakeRim,Y.snakeLift),Z.setSunAzimuth(Math.atan2(Y.sunDir.z,Y.sunDir.x))}function ew(e){et=e,Z.setReducedMotion(e),H.setReducedMotion(e),X.setReducedMotion(e)}function ex(e,t){if(e<=0||t<=0)return;U.setSize(e,t,!1),Z.setAspect(e/t),j.setSize(e,t);let i=t*U.getPixelRatio();O.setScale(i,Z.camera.fov),W.setScale(i,Z.camera.fov)}return ev(),ew(et),{frame({prev:e,cur:i,alpha:s,dt:o,draw:n=!0}){eh+=o,"paused"!==i.status&&(eu+=o);let l=(e.head.x-i.head.x)**2+(e.head.z-i.head.z)**2>1,h=l?1:s,u={x:(0,r.lerp)(e.head.x,i.head.x,h),z:(0,r.lerp)(e.head.z,i.head.z,h)},c=l?i.heading:e.heading+(0,r.angleDiff)(e.heading,i.heading)*h;"playing"===i.status&&E.push(u.x,u.z,eu),em.length=0,em.push(u);for(let e=0;e<i.path.length&&!((0,a.arcAt)(i.carry,e)>i.bodyLength);e++)em.push(i.path[e]);if("idle"===i.status){E.clear();for(let e=em.length-1;e>=0;e--)E.push(em[e].x,em[e].z,eu-7)}let f=null===ec?0:Math.min(1,(eh-ec)/.8);for(let e of(V.update(em,c,o,i.speed,f*f*(3-2*f),"playing"===i.status),H.sync(i.food,i.time,eh),i.food))"golden"===e.kind&&"gameover"!==i.status&&(eg.set(e.pos.x,d(e.pos.x,e.pos.z)+.55,e.pos.z),X.sparkle(eg,o));"playing"===i.status&&X.spray(u,c,i.speed,o),X.wisps(o,Z.focus()),X.update(o);let p=i.food.find(e=>"golden"===e.kind)??i.food[0];if(Z.update(o,u,c,i.status,p?p.pos:null),K&&q<1&&(q=Math.min(1,q+o/.6),z(K,T[$],q*q*(3-2*q),Y),ev(),q>=1&&(K=null)),N.update(eh,Z.camera.position),I.setTime(eh),"high"===G&&o>0){let e;(ep=(ef=.95*ef+.05*o)>.022?ep+o:0)>2&&(G="low",U.setPixelRatio(Math.min(window.devicePixelRatio,1.5)),j.setQuality("low"),N.setShadowSize(1024),X.setBudget(.5),ex((e=U.getSize(new t.Vector2)).x,e.y))}n&&(E.render(U,eu),j.render())},handleEvents(e,i){for(let r of e)if("eat"===r.type||"expire"===r.type){let e=new t.Vector3(r.food.pos.x,d(r.food.pos.x,r.food.pos.z)+.55,r.food.pos.z);"eat"===r.type?(X.eatBurst(e,r.food.kind),Z.shake("golden"===r.food.kind?.35:.15)):X.puff(e)}else"death"===r.type&&(ec=eh,X.impact(new t.Vector3(i.head.x,0,i.head.z)),X.deathDust((0,s.bodyPoints)(i)),Z.shake(.8))},reset(){E.clear(),X.clear(),H.clear(),ec=null},screenToGround(t,i){let s=e.getBoundingClientRect();if(0===s.width||0===s.height)return null;let r=(t-s.left)/s.width*2-1,a=-((i-s.top)/s.height*2-1);return Z.screenToGround(r,a)},setTheme(e,t=!1){(e!==$||K)&&($=e,t||et?(z(T[e],T[e],0,Y),ev(),K=null,q=1):(K=A(Y),q=0))},setReducedMotion:ew,resize:ex,dispose(){E.dispose(),I.dispose(),N.dispose(),V.dispose(),H.dispose(),O.dispose(),W.dispose(),j.dispose(),U.dispose(),U.forceContextLoss()}}}],83493)}]);