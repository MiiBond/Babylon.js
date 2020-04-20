import { Observable } from "../Misc/observable";
import { Scene } from "../scene";
import { Texture } from "../Materials/Textures/texture";
import { MultiRenderTarget } from '../Materials/Textures/multiRenderTarget';
import { Color4 } from '../Maths/math';
import { RenderTargetTexture } from '../Materials/Textures/renderTargetTexture';
import { Effect } from '../Materials/effect';
import { PostProcess, PostProcessOptions } from '../PostProcesses/postProcess';
import { Engine } from '../Engines/engine';
import { Constants } from "../Engines/constants";
import "../Shaders/adobeTransparentComposite.fragment";
/**
 *
 */
export interface IAdobeTransparencyCompositorOptions {

    /**
     * The size of the render buffers
     */
    renderSize: number;
    passesToEnable: number;
    volumeRendering: boolean;
    refractionScale: number;
    sceneScale: number;
    animationTime: number;
}

/**
 *
 */
export class AdobeTransparencyCompositor {

    /**
     * Creates the default options for the helper.
     */
    private static _getDefaultOptions(): IAdobeTransparencyCompositorOptions {
        return {
            renderSize: 256,
            volumeRendering: false,
            refractionScale: 1.0,
            sceneScale: 1.0,
            passesToEnable: 2,
            animationTime: 1000
        };
    }

    public backgroundTexture: Texture;
    public backgroundDepthTexture: Texture;
    public transparentTextures: MultiRenderTarget[];
    public compositedTexture: RenderTargetTexture;

    /**
     * Stores the creation options.
     */
    private _options: IAdobeTransparencyCompositorOptions;
    private _postProcesses: PostProcess[] = [];
    private _scene: Scene;
    private _effectOpacity: number[] = [];

    /**
     * This observable will be notified with any error during the creation of the environment,
     * mainly texture creation errors.
     */
    public onErrorObservable: Observable<{ message?: string, exception?: any }>;

    /**
     * constructor
     * @param options Defines the options we want to customize the helper
     * @param scene The scene to add the material to
     */
    constructor(options: Partial<IAdobeTransparencyCompositorOptions>, scene: Scene) {
        this._options = {
            ...AdobeTransparencyCompositor._getDefaultOptions(),
            ...options
        };
        this._scene = scene;
        this.onErrorObservable = new Observable();
        this._createCompositorRT();
        for (let i = this._options.passesToEnable - 1; i >= 0; i--) {
            this._createPass(i);
        }
    }

    /**
     * Updates the background according to the new options
     * @param options
     */
    public updateOptions(options: Partial<IAdobeTransparencyCompositorOptions>) {
        const newOptions = {
            ...this._options,
            ...options
        };

        const oldOptions = this._options;
        this._options = newOptions;
        if (newOptions.renderSize !== oldOptions.renderSize) {
            this._createCompositorRT();
        }

        if (newOptions.passesToEnable !== oldOptions.passesToEnable || this._postProcesses.length !== newOptions.passesToEnable) {
            this._destroyPasses();
            for (let i = newOptions.passesToEnable - 1; i >= 0; i--) {
                this._createPass(i);
            }
            const newPasses = newOptions.passesToEnable - oldOptions.passesToEnable;
            if (newPasses > 0) {
                this._animatePasses(newPasses, this._options.animationTime);
            }
        }
    }

    public render(): void {
        this._scene.postProcessManager.directRender(this._postProcesses, this.compositedTexture.getInternalTexture());
    }

    public setTransparentTextures(mrt: MultiRenderTarget[]) {
        this.transparentTextures = mrt;

    }

    public setBackgroundTexture(background: Texture) {
        this.backgroundTexture = background;

    }
    public setBackgroundDepthTexture(background: Texture) {
        this.backgroundDepthTexture = background;
    }

    private _createPass(passNum: number): void {
        
        const postOptions: PostProcessOptions = {
            width: this._options.renderSize,
            height: this._options.renderSize
        };

        let floatTextureType = 0;
        // if (this._scene.getEngine().getCaps().textureHalfFloatRender) {
        //     floatTextureType = Engine.TEXTURETYPE_HALF_FLOAT;
        // }
        // else if (this._scene.getEngine().getCaps().textureFloatRender) {
        floatTextureType = Engine.TEXTURETYPE_FLOAT;
        // }

        let defines = "";
        if (passNum == this._options.passesToEnable - 1) {
            defines += "#define BACKGROUND_DEPTH\n";
        }
        if (this._options.volumeRendering) {
            defines += "#define VOLUME_RENDERING\n";
        }
        if (this._scene.getEngine().getCaps().textureLOD) {
            defines += "#define LODBASEDMICROSFURACE\n";
        }
        defines += "#define REFRACTION_SCALE " + this._options.refractionScale.toFixed(20) + "\n";
        defines += "#define TRANSPARENCY_SCENE_SCALE " + this._options.sceneScale.toFixed(20) + "\n";
        let postEffect = new PostProcess("transparentComposite", "adobeTransparentComposite", ["renderSize", "renderOpacity", "depthValues"],
            ["colourTexture", "reflectionTexture", "miscTexture", "attenuationTexture", "scatterTexture", "backgroundDepth"],
            postOptions, null, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, this._scene.getEngine(), undefined, defines, floatTextureType);
        
        postEffect.getEffect().setFloat("renderOpacity", 1.0);
        postEffect.onApplyObservable.add((effect: Effect) => {
            postEffect._textures.forEach((tex) => {
                tex.generateMipMaps = true;
                tex._lodGenerationOffset = -4;
                tex._lodGenerationScale = 0.25;
            });
            const camera = this._scene.activeCamera;
            if (camera) {
                effect.setFloat2("depthValues", camera.minZ, camera.minZ + camera.maxZ);
            }
            if (this.transparentTextures[passNum]) {
                effect.setFloat("renderOpacity", this._effectOpacity[this._effectOpacity.length - 1 - passNum]);
                effect.setFloat("renderSize", this.transparentTextures[passNum].textures[0].getSize().width);
                effect.setTexture("colourTexture", this.transparentTextures[passNum].textures[0]);
                effect.setTexture("reflectionTexture", this.transparentTextures[passNum].textures[1]);
                effect.setTexture("miscTexture", this.transparentTextures[passNum].textures[2]);
    
                if (this._options.volumeRendering) {
                    effect.setTexture("attenuationTexture", this.transparentTextures[passNum].textures[3]);
                    effect.setTexture("scatterTexture", this.transparentTextures[passNum].textures[4]);
                }
    
                if (passNum === this._options.passesToEnable - 1) {
                    effect.setTexture("backgroundDepth", this.backgroundDepthTexture);
                    effect.setTexture("textureSampler", this.backgroundTexture);
                }
            }
        });
        
        this._postProcesses.push(postEffect);
        this._effectOpacity.push(1.0);
    }

    private _destroyPasses(): void {
        this._postProcesses.forEach((postProcess: PostProcess) => {
            postProcess.dispose();
        });
        this._postProcesses = [];
        this._effectOpacity = [];
    }

    private _animatePasses(numPasses: number, time: number = 1000) {
        const startPass = numPasses - 1;
        // Set new passes to 0 opacity;
        for (let i = 0; i <= startPass; i++) {
            this._effectOpacity[i] = 0.0;
        }
        let currentPass = startPass;
        let opacity = 0.0;
        // Frames of animation, assuming 33 ms per frame.
        const frames = time / 33;
        const step = numPasses / frames;
        
        const animationTimeout = setInterval(() => {
            opacity += step;
            if (opacity > 1.0) {
                opacity = 1.0;
            }
            this._effectOpacity[currentPass] = opacity;
            if (opacity === 1.0) {
                currentPass--;
                opacity = 0.0;
                if (currentPass < 0) {
                    clearInterval(animationTimeout);
                }
            }
        }, 0.33);
    }

    private _createCompositorRT(): void {
        let floatTextureType = 0;
        // if (this._scene.getEngine().getCaps().textureHalfFloatRender) {
        //     floatTextureType = Engine.TEXTURETYPE_HALF_FLOAT;
        // }
        // else if (this._scene.getEngine().getCaps().textureFloatRender) {
        floatTextureType = Engine.TEXTURETYPE_FLOAT;
        // }

        this.compositedTexture = new RenderTargetTexture("trans_composite_output", this._options.renderSize, this._scene, true, undefined, floatTextureType, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, false, false, false);
        this.compositedTexture.clearColor = new Color4(1, 0, 1, 1);
        this.compositedTexture.lodGenerationScale = 1;
        this.compositedTexture.lodGenerationOffset = -4;
        this.compositedTexture.wrapU = Engine.TEXTURE_CLAMP_ADDRESSMODE;
        // this.compositedTexture.samples = 4;
        this.compositedTexture.gammaSpace = true;
        // this.compositedTexture.hasAlpha = true;
        // this.compositedTexture.anisotropicFilteringLevel = 8;
        (this.compositedTexture as any).depth = this._options.refractionScale;

    }

    // private _errorHandler = (message?: string, exception?: any) => {
    //     this.onErrorObservable.notifyObservers({ message: message, exception: exception });
    // }

    /**
     * Dispose all the elements created by the Helper.
     */
    public dispose(): void {
        this.compositedTexture.dispose();
        this._postProcesses.forEach((post) => {
            post.dispose();
        });
    }
}