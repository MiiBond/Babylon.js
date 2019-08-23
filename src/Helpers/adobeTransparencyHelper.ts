import { Observable } from "../Misc/observable";
import { Nullable } from "../types";
import { Scene } from "../scene";
import { AbstractMesh } from "../Meshes/abstractMesh";
import { Mesh } from "../Meshes/mesh";
import { Texture } from "../Materials/Textures/texture";
import { _TimeToken } from "../Instrumentation/timeToken";
import { _DepthCullingState, _StencilState, _AlphaState } from "../States/index";
import { Constants } from "../Engines/constants";

import "../Meshes/Builders/planeBuilder";
import "../Meshes/Builders/boxBuilder";
import { MultiRenderTarget } from '../Materials/Textures/multiRenderTarget';
import { Color4 } from '../Maths/math';
import { Material } from '../Materials/material';
import { PBRMaterial } from '../Materials/PBR/pbrMaterial';
// import { PBRBaseMaterial } from '../Materials/PBR/pbrBaseMaterial';
// import { ShaderMaterial } from '../Materials/shaderMaterial';
import { AdobeTransparencyCompositor } from './adobeTransparencyCompositor';
import { RenderTargetTexture } from '../Materials/Textures/renderTargetTexture';
import { DepthRenderer } from '../Rendering/depthRenderer';
import { Engine } from '../Engines/engine';

/**
 *
 */
export interface IAdobeTransparencyHelperOptions {
    /**
     * Number of layers of transparency that can be rendered. The higher the number, the slower the performance.
     */
    numPasses: number;

    /**
     * The size of the render buffers
     */
    renderSize: number;

    /**
     * The amount of distortion caused when refracting light through a material.
     */
    refractionScale: number;

    /**
     * The number of scene units in 1 meter. This is used so that an entire scene can be scaled
     * without the interior of transparent objects being affected.
     */
    sceneScale: number;
}

/**
 *
 */
export class AdobeTransparencyHelper {

    /**
     * Creates the default options for the helper.
     */
    private static _getDefaultOptions(): IAdobeTransparencyHelperOptions {
        return {
            numPasses: 4,
            renderSize: 256,
            refractionScale: 1.0,
            sceneScale: 1.0
        };
    }

    /**
     * Stores the creation options.
     */
    private readonly _scene: Scene;
    private _options: IAdobeTransparencyHelperOptions;
    private _opaqueRenderTarget: RenderTargetTexture;
    private _opaqueDepthRenderer: DepthRenderer;
    private _frontDepthRenderer: DepthRenderer;
    private _mrtRenderTargets: MultiRenderTarget[] = [];
    private _opaqueMeshesCache: Mesh[] = [];
    private _transparentMeshesCache: Mesh[] = [];
    private _compositor: AdobeTransparencyCompositor;
    private _mrtDisabled: Boolean = false;
    private _volumeRenderingEnabled: boolean = false;

    public disabled: boolean = false;

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
    constructor(options: Partial<IAdobeTransparencyHelperOptions>, scene: Scene) {
        this._options = {
            ...AdobeTransparencyHelper._getDefaultOptions(),
            ...options
        };
        this._scene = scene;
        this.onErrorObservable = new Observable();
        this._parseScene();

        const engine = scene.getEngine();
        
        if (!engine.getCaps().drawBuffersExtension) {
            this._mrtDisabled = true;
        }
        this._volumeRenderingEnabled = (engine._gl as any).COLOR_ATTACHMENT4 !== undefined;
        this._setupRenderTargets();
    }

    /**
     * Updates the background according to the new options
     * @param options
     */
    public updateOptions(options: Partial<IAdobeTransparencyHelperOptions>) {
        // First check if any options are actually being changed. If not, exit.
        const newValues = Object.keys(options).filter((key: string) => (this._options as any)[key] !== (options as any)[key as any]);
        if (!newValues.length) {
            return;
        }
        
        const newOptions = {
            ...this._options,
            ...options
        };

        this._options = newOptions;
        this._setupRenderTargets();
    }

    public getRenderTarget(pass: number = 0): Nullable<Texture> {
        if (this._mrtRenderTargets.length <= pass) {
            return null;
        }
        return this._mrtRenderTargets[pass];
    }

    public getRenderTargetTexture(pass: number = 0, mrtIndex: number = 0): Nullable<Texture> {
        if (this._mrtRenderTargets.length <= pass || this._mrtRenderTargets[pass].textures.length <= mrtIndex) {
            return null;
        }
        return this._mrtRenderTargets[pass].textures[mrtIndex];
    }

    public getFinalComposite(): Nullable<Texture> {
        if (this._mrtDisabled) {
            return this._opaqueRenderTarget;
        }
        if (!this._compositor) {
            return null;
        }
        return this._compositor.compositedTexture;
    }

    public getOpaqueTarget(): Nullable<Texture> {
        return this._opaqueRenderTarget;
    }

    public getNumPasses(): number {
        return this._options.numPasses;
    }

    private shouldRenderAsTransparency(material: Nullable<Material>): boolean {
        if (!material) {
            return false;
        }
        if (material instanceof PBRMaterial && (material.transparency.isEnabled || material.needAlphaBlending())) {
            // This is a bit of a hack to force alpha-blended geometry to render with our scene refraction.
            if (material.needAlphaBlending()) {
                material.transparency.isEnabled = true;
                material.getRenderTargetTextures = null;
            }
            material.refractionTexture = this.getFinalComposite();
            material.transparency.refractionScale = this._options.refractionScale;
            material.transparency.sceneScale = this._options.sceneScale;
            material.transparency.depthInRefractionAlpha = !this._mrtDisabled;
            return true;
        }
        return false;
    }

    private _addMesh(mesh: AbstractMesh): void {
        if (mesh instanceof Mesh) {
            mesh.onMaterialChangedObservable.add(this.onMeshMaterialChanged.bind(this));
            if (this.shouldRenderAsTransparency(mesh.material)) {
                this._transparentMeshesCache.push(mesh);
            } else {
                this._opaqueMeshesCache.push(mesh);
            }
        }
        if (this._transparentMeshesCache.length == 0) {
            this.disabled = true;
        } else {
            this.disabled = false;
        }
    }

    private _removeMesh(mesh: AbstractMesh): void {
        if (mesh instanceof Mesh) {
            mesh.onMaterialChangedObservable.remove(this.onMeshMaterialChanged.bind(this));
            let idx = this._transparentMeshesCache.indexOf(mesh);
            if (idx !== -1) {
                this._transparentMeshesCache.splice(idx, 1);
            }
            idx = this._opaqueMeshesCache.indexOf(mesh);
            if (idx !== -1) {
                this._opaqueMeshesCache.splice(idx, 1);
            }
        }
        if (this._transparentMeshesCache.length == 0) {
            this.disabled = true;
        } else {
            this.disabled = false;
        }
    }

    private _parseScene(): void {
        this._scene.meshes.forEach(this._addMesh.bind(this));
        // Listen for when a mesh is added to the scene and add it to our cache lists.
        this._scene.onNewMeshAddedObservable.add(this._addMesh.bind(this));
        // Listen for when a mesh is removed from to the scene and remove it from our cache lists.
        this._scene.onMeshRemovedObservable.add(this._removeMesh.bind(this));
    }

    // When one of the meshes in the scene has its material changed, make sure that it's in the correct cache list.
    private onMeshMaterialChanged(mesh: AbstractMesh) {
        if (mesh instanceof Mesh) {
            let transparent_idx = this._transparentMeshesCache.indexOf(mesh);
            let opaque_idx = this._opaqueMeshesCache.indexOf(mesh);

            // If the material is transparent, make sure that it's added to the transparent list and removed from the opaque list
            if (this.shouldRenderAsTransparency(mesh.material)) {
                if (opaque_idx !== -1) {
                    this._opaqueMeshesCache.splice(opaque_idx, 1);
                    this._transparentMeshesCache.push(mesh);
                } else if (transparent_idx === -1) {
                    this._transparentMeshesCache.push(mesh);
                }
                // If the material is opaque, make sure that it's added to the opaque list and removed from the transparent list
            } else {
                if (transparent_idx !== -1) {
                    this._transparentMeshesCache.splice(transparent_idx, 1);
                    this._opaqueMeshesCache.push(mesh);
                } else if (opaque_idx === -1) {
                    this._opaqueMeshesCache.push(mesh);
                }
            }
        }
        if (this._transparentMeshesCache.length == 0) {
            this.disabled = true;
        } else {
            this.disabled = false;
        }
    }

    /**
     * Setup the image processing according to the specified options.
     */
    private _setupRenderTargets(): void {
        let floatTextureType = 0;
        // if (this._scene.getEngine().getCaps().textureHalfFloatRender) {
        //     floatTextureType = Engine.TEXTURETYPE_HALF_FLOAT;
        // }
        // else if (this._scene.getEngine().getCaps().textureFloatRender) {
            floatTextureType = Engine.TEXTURETYPE_FLOAT;
        // }
        
        // Remove any layers rendering to the opaque scene.
        if (this._scene.layers) {
            this._scene.layers.forEach((layer) => {
                let idx = layer.renderTargetTextures.indexOf(this._opaqueRenderTarget);
                if (idx >= 0) {
                    layer.renderTargetTextures.splice(idx, 1);
                }
            });
        }

        // Remove opaque render target
        let rt_idx = this._scene.customRenderTargets.indexOf(this._opaqueRenderTarget);
        if (this._opaqueRenderTarget) {
            this._opaqueRenderTarget.dispose();
        }

        if (!this.disabled) {
            this._opaqueRenderTarget = new RenderTargetTexture("opaqueSceneTexture", this._options.renderSize, this._scene, true);
            this._opaqueRenderTarget.renderList = this._opaqueMeshesCache;
            // this._opaqueRenderTarget.clearColor = new Color4(0.0, 0.0, 0.0, 0.0);
            this._opaqueRenderTarget.lodGenerationScale = 1;
            this._opaqueRenderTarget.lodGenerationOffset = -4;
            (this._opaqueRenderTarget as any).depth = this._options.refractionScale;
            if (rt_idx >= 0) {
                this._scene.customRenderTargets.splice(rt_idx, 0, this._opaqueRenderTarget);
            } else {
                this._scene.customRenderTargets.push(this._opaqueRenderTarget);
            }

            // If there are other layers, they should be included in the render of the opaque background.
            if (this._scene.layers) {
                this._scene.layers.forEach((layer) => {
                    layer.renderTargetTextures.push(this._opaqueRenderTarget);
                });
            }
        }

        if (this._mrtDisabled) {
            if (!this.disabled) {
                this._transparentMeshesCache.forEach((mesh: AbstractMesh) => {
                    if (this.shouldRenderAsTransparency(mesh.material) && mesh.material instanceof PBRMaterial) {
                        mesh.material.refractionTexture = this._opaqueRenderTarget;
                    }
                });
            }
            return;
        }
        
        if (this._opaqueDepthRenderer) {
            rt_idx = this._scene.customRenderTargets.indexOf(this._opaqueDepthRenderer.getDepthMap());
            this._opaqueDepthRenderer.dispose();
        }
        if (!this.disabled) {
            this._opaqueDepthRenderer = new DepthRenderer(this._scene, Engine.TEXTURETYPE_FLOAT, null, false, this._options.renderSize);
            this._opaqueDepthRenderer.getDepthMap().renderList = this._opaqueMeshesCache;
            this._opaqueDepthRenderer.getDepthMap().updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);

            if (rt_idx >= 0) {
                this._scene.customRenderTargets.splice(rt_idx, 0, this._opaqueDepthRenderer.getDepthMap());
            } else {
                this._scene.customRenderTargets.push(this._opaqueDepthRenderer.getDepthMap());
            }
        }

        // Render the depth of the front-layer of transparent meshes.
        if (this._frontDepthRenderer) {
            rt_idx = this._scene.customRenderTargets.indexOf(this._frontDepthRenderer.getDepthMap());
            this._frontDepthRenderer.dispose();
        }

        this._frontDepthRenderer = new DepthRenderer(this._scene, Engine.TEXTURETYPE_FLOAT, null, false, this._options.renderSize);
        this._frontDepthRenderer.getDepthMap().renderList = this._transparentMeshesCache;
        this._frontDepthRenderer.getDepthMap().updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);

        if (!this.disabled) {
            if (rt_idx >= 0) {
                this._scene.customRenderTargets.splice(rt_idx, 0, this._frontDepthRenderer.getDepthMap());
            } else {
                this._scene.customRenderTargets.push(this._frontDepthRenderer.getDepthMap());
            }
        }

        // Before creating MRT's and depth passes, remove the existing ones.
        this._mrtRenderTargets.forEach((mrt) => {
            mrt.onBeforeRenderObservable.clear();
            mrt.onAfterRenderObservable.clear();
            mrt.dispose();
        });

        this._transparentMeshesCache.forEach((mesh: AbstractMesh) => {
            if (this.shouldRenderAsTransparency(mesh.material) && mesh.material instanceof PBRMaterial) {
                mesh.material.refractionTexture = null;
            }
        });

        // Create all the render targets for the depth-peeling passes
        this._mrtRenderTargets = [];
        
        if (this.disabled) {
            return;
        }

        for (let idx = 0; idx < this._options.numPasses; idx++) {
            
            const renderBufferCount = this._volumeRenderingEnabled ? 5 : 3;
            const multiRenderTarget = new MultiRenderTarget("transparency_mrt_" + idx, this._options.renderSize, renderBufferCount, this._scene, {
                defaultType: floatTextureType,
                types: [Constants.TEXTURETYPE_UNSIGNED_BYTE, floatTextureType, Constants.TEXTURETYPE_UNSIGNED_BYTE, Constants.TEXTURETYPE_UNSIGNED_BYTE, Constants.TEXTURETYPE_UNSIGNED_BYTE],
                samplingModes: [MultiRenderTarget.BILINEAR_SAMPLINGMODE],
                doNotChangeAspectRatio: true,
                generateMipMaps: true
            });
            multiRenderTarget.wrapU = Texture.CLAMP_ADDRESSMODE;
            multiRenderTarget.wrapV = Texture.CLAMP_ADDRESSMODE;
            multiRenderTarget.refreshRate = 1;
            multiRenderTarget.renderParticles = false;
            multiRenderTarget.renderList = null;
            multiRenderTarget.clearColor = new Color4(0.0, 0.0, 0.0, 0.0);
            // multiRenderTarget.lodGenerationScale = 1;
            multiRenderTarget.anisotropicFilteringLevel = 4;
            // multiRenderTarget.noMipmap = true;
            // multiRenderTarget.samplingMode = Texture.BILINEAR_SAMPLINGMODE;
            // multiRenderTarget.lodGenerationOffset = -0.5;
            multiRenderTarget.textures.forEach((tex) => tex.hasAlpha = true);

            multiRenderTarget.renderList = this._transparentMeshesCache;
            // multiRenderTarget.renderList = this._opaqueMeshesCache;
            multiRenderTarget.onBeforeRenderObservable.add((eventData: number, eventState: any) => {

                // Enable transparent materials to output to MRT
                if (multiRenderTarget.renderList) {
                    multiRenderTarget.renderList.forEach((mesh: AbstractMesh) => {
                        if (this.shouldRenderAsTransparency(mesh.material) && mesh.material instanceof PBRMaterial) {
                            mesh.material.useAdobeGBufferRendering = true;
                            // mesh.material.backFaceCulling = false;
                            mesh.material.adobeGBufferVolumeInfoEnabled = this._volumeRenderingEnabled;
                            if (idx > 0) {
                                mesh.material.transparency.frontDepthTexture = this._mrtRenderTargets[idx - 1].textures[1];
                                mesh.material.transparency.frontDepthTextureIsInverse = true;
                            } else {
                                mesh.material.transparency.frontDepthTexture = this._frontDepthRenderer.getDepthMap();
                                mesh.material.transparency.frontDepthTextureIsInverse = false;
                            }
                            mesh.material.transparency.backDepthTexture = this._opaqueDepthRenderer.getDepthMap();
                            // (mesh.material as PBRMaterial).sideOrientation = PBRMaterial.CounterClockWiseSideOrientation;
                            mesh.material.backFaceCulling = false;
                            // mesh.material.twoSidedLighting = true;
                            mesh.material.forceNormalForward = true;
                            // (mesh.material as PBRMaterial).disableDepthWrite = true;
                            mesh.material.refractionTexture = mesh.getScene().environmentTexture;
                        }
                    });
                }
            });
            if (idx == this._options.numPasses - 1) {
                multiRenderTarget.onAfterRenderObservable.add((eventData: number) => {
                    // Disable transparent materials to output to MRT
                    if (multiRenderTarget.renderList) {

                        multiRenderTarget.renderList.forEach((mesh: AbstractMesh) => {
                            if (this.shouldRenderAsTransparency(mesh.material) && mesh.material instanceof PBRMaterial) {
                                mesh.material.useAdobeGBufferRendering = false;
                                mesh.material.adobeGBufferVolumeInfoEnabled = false;
                                // (mesh.material as PBRMaterial).sideOrientation = PBRMaterial.ClockWiseSideOrientation;
                                mesh.material.backFaceCulling = true;
                                // mesh.material.twoSidedLighting = false;
                                // mesh.material.forceNormalForward = false;
                                // (mesh.material as PBRMaterial).disableDepthWrite = false;
                                mesh.material.refractionTexture = this.getFinalComposite();
                                // (mesh.material as PBRMaterial).subSurface.isTranslucencyEnabled = true;
                            }
                        });
                    }
                });
            }

            this._mrtRenderTargets.push(multiRenderTarget);
        }

        // Add MRT's to render targets list.
        if (rt_idx >= 0) {
            this._scene.customRenderTargets.splice(rt_idx + 1, 0, ...this._mrtRenderTargets);
        } else {
            this._mrtRenderTargets.forEach((target) => this._scene.customRenderTargets.push(target));
        }

        if (this._compositor) {
            this._compositor.dispose();
        }
        this._compositor = new AdobeTransparencyCompositor({
            renderSize: this._options.renderSize,
            numPasses: this._options.numPasses,
            volumeRendering: this._volumeRenderingEnabled,
            refractionScale: this._options.refractionScale,
            sceneScale: this._options.sceneScale }, this._scene);
        this._compositor.setBackgroundDepthTexture(this._opaqueDepthRenderer.getDepthMap());
        this._compositor.setBackgroundTexture(this._opaqueRenderTarget);
        this._compositor.setTransparentTextures(this._mrtRenderTargets);

        this._mrtRenderTargets[this._mrtRenderTargets.length - 1].onAfterRenderObservable.add((eventData: number) => {
            this._compositor.render();
        });
    }

    // private _errorHandler = (message?: string, exception?: any) => {
    //     this.onErrorObservable.notifyObservers({ message: message, exception: exception });
    // }

    /**
     * Dispose all the elements created by the Helper.
     */
    public dispose(): void {

    }
}
