// Night lights of the fleet (B1), both additive, no depth write, LAYER_NO_INK:
//   (1) beams: a soft pool of headlight on the asphalt ahead of every vehicle (two lobes from the
//       lamps widening into one warm fan), bent to the planet's curve; from above ~60 m a short
//       amber smudge (~6 m) ahead of the car, gone by 260 m;
//   (2) sparks: one point per headlight pair and per tail-light pair, taking over from the lamp
//       meshes past ~15 m, so from the rooftops to orbit the night streets read as strands of warm
//       white and red beads. A head spark only shows from ahead, a tail spark from behind (both
//       from above); brake lights flare.
// The toon lamps on the meshes themselves glow in the vehicle patch (index.ts).

import { AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, InstancedMesh, Points, ShaderMaterial, Vector2 } from 'three';
import { LAYER_NO_INK, type LBContext } from '../core/contracts';
import { LB_COMMON_GLSL } from '../render/toon';
import { CITY_SURFACE_R } from '../world/config';

const beamVert = /* glsl */ `
${LB_COMMON_GLSL}
varying vec2 vL;
varying vec3 vW;
void main(){
vec3 p=position;
vL=p.xz;
p.y -= dot(p.xz, p.xz) / (2.0 * ${CITY_SURFACE_R.toFixed(2)});
vec4 w=modelMatrix*instanceMatrix*vec4(p,1.0);
vW=w.xyz;
gl_Position=projectionMatrix*viewMatrix*w;
}
`;

const beamFrag = /* glsl */ `
${LB_COMMON_GLSL}
uniform float uReveal;
varying vec2 vL;
varying vec3 vW;
void main(){
float z=vL.y;
float x=abs(vL.x);
float c=0.55*(1.0-smoothstep(0.0,5.0,z));
float w=0.35+0.26*z;
float d=(x-c)/w;
float lobe=exp(-d*d*1.6);
float fr=smoothstep(30.0,60.0,lbCamAlt);
float along=smoothstep(-0.2,0.9,z)*(1.0-smoothstep(mix(3.5,1.5,fr),mix(10.5,6.0,fr),z))/(1.0+0.05*z*z);
float k=lobe*along*lbNightAt(vW)*uReveal*mix(1.0,0.5,smoothstep(30.0,90.0,lbCamAlt))*(1.0-smoothstep(170.0,260.0,lbCamAlt));
if(k<0.002)discard;
gl_FragColor=vec4(mix(vec3(1.0,0.78,0.48),vec3(1.0,0.66,0.33),fr)*k*0.95,1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}
`;

const sparkVert = /* glsl */ `
${LB_COMMON_GLSL}
uniform vec2 uViewport;
uniform float uReveal;
attribute vec4 aDir;
attribute float aTail;
varying vec3 vCol;
varying float vA;
void main(){
vec4 w=modelMatrix*vec4(position,1.0);
vec3 toCam=lbCamPos-w.xyz;
float d=length(toCam);
vec3 V=toCam/max(d,1e-3);
w.xyz+=V*min(0.5,d*0.004);
vec4 mv=viewMatrix*w;
gl_Position=projectionMatrix*mv;
float pxPerM=projectionMatrix[1][1]*uViewport.y*0.5/max(-mv.z,0.1);
float facing=dot(aDir.xyz,V)*(aTail>0.5?-1.0:1.0);
float face=smoothstep(-0.35,0.1,facing)*mix(0.55,1.0,smoothstep(0.1,0.7,facing));
face=mix(face,1.0,smoothstep(0.35,0.8,dot(normalize(w.xyz),V)));
float tail=aTail>0.5?0.6+0.9*aDir.w:1.0;
vA=face*tail*smoothstep(14.0,36.0,d)*lbNightAt(w.xyz)*uReveal;
vCol=aTail>0.5?vec3(1.0,0.1,0.06):vec3(1.0,0.86,0.6);
gl_PointSize=clamp(pxPerM*1.25,3.2,7.0)*(aTail>0.5?0.85:1.0);
if(vA<0.003)gl_Position=vec4(2.0,2.0,2.0,1.0);
}
`;

const sparkFrag = /* glsl */ `
${LB_COMMON_GLSL}
varying vec3 vCol;
varying float vA;
void main(){
float r=length(gl_PointCoord-0.5)*2.0;
if(r>1.0)discard;
float core=1.0-smoothstep(0.25,0.55,r);
float halo=(1.0-r)*(1.0-r);
gl_FragColor=vec4(vCol*(core*1.9+halo*0.5)*vA,1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}
`;

export interface FleetLights {
  beams: InstancedMesh;
  sparks: Points;
  /** Spark positions (2 per vehicle: head, tail) and aDir, written per frame. */
  pos: Float32Array;
  dir: Float32Array;
  posAttr: BufferAttribute;
  dirAttr: BufferAttribute;
  beamMat: ShaderMaterial;
  sparkMat: ShaderMaterial;
}

export function createFleetLights(ctx: LBContext, n: number): FleetLights {
  // beam grid in the vehicle's ground frame: x ∈ [−3.6, 3.6], z ∈ [0, 11] ahead of the bumper
  const NX = 8;
  const NZ = 12;
  const P: number[] = [];
  const I: number[] = [];
  for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NX; i++) P.push(-3.6 + (7.2 * i) / NX, 0, (11 * j * j) / (NZ * NZ) - 0.3);
  for (let j = 0; j < NZ; j++)
    for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i;
      I.push(a, a + NX + 1, a + 1, a + 1, a + NX + 1, a + NX + 2);
    }
  const bg = ctx.track(new BufferGeometry());
  bg.setAttribute('position', new BufferAttribute(new Float32Array(P), 3));
  bg.setIndex(I);
  const beamMat = ctx.track(
    new ShaderMaterial({
      name: 'traffic:beams',
      vertexShader: beamVert,
      fragmentShader: beamFrag,
      uniforms: { ...ctx.uniforms, uReveal: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    }),
  );
  const beams = new InstancedMesh(bg, beamMat, n);
  beams.instanceMatrix.setUsage(DynamicDrawUsage);
  beams.name = 'traffic:beams';
  beams.layers.set(LAYER_NO_INK);
  beams.frustumCulled = false;
  beams.renderOrder = 2;

  const pos = new Float32Array(n * 6);
  const dir = new Float32Array(n * 8);
  const tail = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) tail[i * 2 + 1] = 1;
  const sg = ctx.track(new BufferGeometry());
  const posAttr = new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage);
  const dirAttr = new BufferAttribute(dir, 4).setUsage(DynamicDrawUsage);
  sg.setAttribute('position', posAttr);
  sg.setAttribute('aDir', dirAttr);
  sg.setAttribute('aTail', new BufferAttribute(tail, 1));
  const sparkMat = ctx.track(
    new ShaderMaterial({
      name: 'traffic:sparks',
      vertexShader: sparkVert,
      fragmentShader: sparkFrag,
      uniforms: { ...ctx.uniforms, uReveal: { value: 1 }, uViewport: { value: new Vector2(1280, 800) } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  const sparks = new Points(sg, sparkMat);
  sparks.name = 'traffic:sparks';
  sparks.layers.set(LAYER_NO_INK);
  sparks.frustumCulled = false;
  sparks.renderOrder = 3;
  return { beams, sparks, pos, dir, posAttr, dirAttr, beamMat, sparkMat };
}
