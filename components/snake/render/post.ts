import { HalfFloatType, Vector2, WebGLRenderTarget, type Camera, type Scene, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export type Quality = 'high' | 'low';

/** High: MSAA HDR target → bloom → tone mapping. Low: straight to the canvas (tone mapped by the renderer). */
export class PostPipeline {
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private strength = 0.3;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: Camera,
    quality: Quality,
  ) {
    this.setQuality(quality);
  }

  setQuality(quality: Quality): void {
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    if (quality === 'low') return;
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    const target = new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, target);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(size.x, size.y), this.strength, 0.55, 0.95);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  setSize(width: number, height: number): void {
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }

  setBloom(strength: number): void {
    this.strength = strength;
    if (this.bloom) this.bloom.strength = strength;
  }

  render(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.composer?.dispose();
  }
}
