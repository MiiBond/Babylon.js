import { Observable } from "../Misc/observable";
// import { Nullable } from "../types";
// import { Camera } from "../Cameras/camera";
import { Scene } from "../scene";
// import { Vector3, Color3, Color4, Plane } from "../Maths/math";
// import { AbstractMesh } from "../Meshes/abstractMesh";
// import { Mesh } from "../Meshes/mesh";
// import { BaseTexture } from "../Materials/Textures/baseTexture";
import { Texture } from "../Materials/Textures/texture";
import { MultiRenderTarget } from '../Materials/Textures/multiRenderTarget';
import { Color4 } from '../Maths/math';
// import { FreeCamera } from '../Cameras/freeCamera';
// import { PBRMaterial } from '../Materials/PBR/pbrMaterial';
// import { ShaderMaterial } from '../Materials/shaderMaterial';
import { RenderTargetTexture } from '../Materials/Textures/renderTargetTexture';
// import { Engine } from '../Engines/engine';
// import { PlaneBuilder } from '../Meshes/Builders/planeBuilder';
import { PostProcess, PostProcessOptions } from '../PostProcesses/postProcess';
import { Engine } from '../Engines/engine';
import { Constants } from "../Engines/constants";
// import { FxaaPostProcess } from '../PostProcesses/fxaaPostProcess';
import "../Shaders/adobeTransparentComposite.fragment";
/**
 *
 */
export interface IAdobeTransparencyCompositorOptions {

    /**
     * The size of the render buffers
     */
    renderSize: number;
    numPasses: number;
    volumeRendering: boolean;
    refractionScale: number;
    sceneScale: number;
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
            numPasses: 4,
            volumeRendering: false,
            refractionScale: 1.0,
            sceneScale: 1.0
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
    private _postProcesses: PostProcess[];
    private _scene: Scene;

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
        this._setupScene();
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

        this._options = newOptions;
        // this._setupCompositePass();
        this._setupScene();
        // this._setupRenderTargets();

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

    private _setupScene(): void {
        let floatTextureType = 0;
        // if (this._scene.getEngine().getCaps().textureHalfFloatRender) {
        //     floatTextureType = Engine.TEXTURETYPE_HALF_FLOAT;
        // }
        // else if (this._scene.getEngine().getCaps().textureFloatRender) {
        floatTextureType = Engine.TEXTURETYPE_FLOAT;
        // }

        this.compositedTexture = new RenderTargetTexture("trans_composite_output", this._options.renderSize, this._scene, true, undefined, floatTextureType, false, undefined, false, false, false);
        this.compositedTexture.clearColor = new Color4(1, 0, 1, 1);
        this.compositedTexture.lodGenerationScale = 1;
        this.compositedTexture.lodGenerationOffset = -4;
        // this.compositedTexture.samples = 4;
        // this.compositedTexture.gammaSpace = false;
        // this.compositedTexture.hasAlpha = true;
        // this.compositedTexture.anisotropicFilteringLevel = 8;
        (this.compositedTexture as any).depth = 0.1 * this._options.refractionScale;

        this._postProcesses = [];

        for (let i = this._options.numPasses - 1; i >= 0; i--) {
            const postOptions: PostProcessOptions = {
                width: this._options.renderSize,
                height: this._options.renderSize
            };

            let defines = "";
            if (i == this._options.numPasses - 1) {
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
            let postEffect = new PostProcess("transparentComposite", "adobeTransparentComposite", ["renderSize"],
                ["colourTexture", "reflectionTexture", "miscTexture", "interiorColorTexture", "interiorInfoTexture", "backgroundDepth"],
                postOptions, null, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, this._scene.getEngine(), undefined, defines, floatTextureType);
            postEffect._textures.forEach((tex) => {
                tex._lodGenerationOffset = -4;
                tex._lodGenerationScale = 0.25;
            });
            postEffect.onApplyObservable.add((effect) => {
                if (this.transparentTextures[i]) {
                    effect.setFloat("renderSize", this.transparentTextures[i].textures[0].getSize().width);
                    effect.setTexture("colourTexture", this.transparentTextures[i].textures[0]);
                    effect.setTexture("reflectionTexture", this.transparentTextures[i].textures[1]);
                    effect.setTexture("miscTexture", this.transparentTextures[i].textures[2]);

                    if (this._options.volumeRendering) {
                        effect.setTexture("interiorColorTexture", this.transparentTextures[i].textures[3]);
                        effect.setTexture("interiorInfoTexture", this.transparentTextures[i].textures[4]);
                    }

                    if (i == this._options.numPasses - 1) {
                        effect.setTexture("backgroundDepth", this.backgroundDepthTexture);
                        effect.setTexture("textureSampler", this.backgroundTexture);
                    }
                }
            });

            this._postProcesses.push(postEffect);
        }

        // const fxaaEffect = new FxaaPostProcess("fxaaInTransparencyComposite", postOptions, null, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, this._scene.getEngine(), false, floatTextureType);
        // this._postProcesses.push(fxaaEffect);

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
