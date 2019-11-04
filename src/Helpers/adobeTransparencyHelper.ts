import { Observable } from "../Misc/observable";
import { Nullable } from "../types";
import { Scene } from "../scene";
import { AbstractMesh } from "../Meshes/abstractMesh";
import { Mesh } from "../Meshes/mesh";
import { Texture } from "../Materials/Textures/texture";
import { _TimeToken } from "../Instrumentation/timeToken";
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
     * Number of layers of transparency that will have resources allocated to. The higher the number, the more memory overhead is needed.
     */
    numPasses: number;

    /**
     * Number of layers of transparency that are currently rendered. The higher the number, the slower the performance.
     */
    passesToEnable: number;

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

class MaterialCacheEntry {
    gbufferMaterial1: PBRMaterial;
    gbufferMaterial2: PBRMaterial;
    regularMaterial: PBRMaterial;
}

interface MaterialCacheMap {[s: string]: MaterialCacheEntry; };

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
            sceneScale: 1.0,
            passesToEnable: 2
        };
    }

    /**
     * Stores the creation options.
     */
    private readonly _scene: Scene;
    private _options: IAdobeTransparencyHelperOptions;
    private _numEnabledPasses: number = 0;
    private _currentMRTIndex: number = -1;
    private _opaqueRTIndex: number = -1;
    
    private _opaqueRenderTarget: RenderTargetTexture;
    private _opaqueDepthRenderer: DepthRenderer;
    private _frontDepthRenderer: DepthRenderer;
    private _mrtRenderTargets: MultiRenderTarget[] = [];
    private _opaqueMeshesCache: Mesh[] = [];
    private _transparentMeshesCache: Mesh[] = [];
    private _compositor: AdobeTransparencyCompositor;
    private _mrtDisabled: Boolean = false;
    private _volumeRenderingEnabled: boolean = false;

    
    private _materialCache: MaterialCacheMap = {};
    // private _regularMaterialCache: MaterialMap;

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
        // this._volumeRenderingEnabled = (engine._gl as any).COLOR_ATTACHMENT5 !== undefined;
        this._setupRenderTargets();

        while (this._numEnabledPasses < this._options.passesToEnable) {
            this.enablePass();
        }
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

        // If size changes, recreate everything
        if (newOptions.renderSize !== this._options.renderSize) {
            this._options = newOptions;
            this._setupRenderTargets();
        // If number of passes changes, create or remove passes as needed.
        } else if (newOptions.numPasses > this._options.numPasses) {
            const numPassesToAdd = newOptions.numPasses - this._options.numPasses;
            this._options = newOptions;
            for (let i = 0; i < numPassesToAdd; i++) {
                this.addPass();
            }
        } else if (newOptions.numPasses < this._options.numPasses) {
            const numPassesToRemove = this._options.numPasses - newOptions.numPasses;
            this._options = newOptions;
            for (let i = 0; i < numPassesToRemove; i++) {
                this.removePass();
            }
        }

        // If only the number of enabled passes changes, just enable or disable passes as needed.
        // This doesn't require creating or deleting any RT's.
        if (options.passesToEnable !== undefined && options.passesToEnable !== this._options.passesToEnable) {
            this._options = newOptions;
            while (this._numEnabledPasses < options.passesToEnable) {
                this.enablePass();
            }
            while (this._numEnabledPasses > options.passesToEnable) {
                this.disablePass();
            }
        }

        this._compositor.updateOptions(options);
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
        if (material instanceof PBRMaterial && (material.subSurface.isRefractionEnabled || material.needAlphaBlending())) {
            // This is a bit of a hack to force alpha-blended geometry to render with our scene refraction.
            if (material.needAlphaBlending()) {
                // material.subSurface.isRefractionEnabled = true;
                // material.getRenderTargetTextures = null;
                // material.forceDepthWrite = true;
                // material.backFaceCulling = false;
            }
            // material.refractionTexture = this.getFinalComposite();
            // material.transparency.refractionScale = this._options.refractionScale;
            // material.transparency.sceneScale = this._options.sceneScale;
            // material.subSurface.depthInRefractionAlpha = !this._mrtDisabled;
            return true;
        }
        return false;
    }

    private _addMesh(mesh: AbstractMesh): void {
        if (mesh instanceof Mesh) {
            // mesh.onMaterialChangedObservable.add(this.onMeshMaterialChanged.bind(this));
            if (this.shouldRenderAsTransparency(mesh.material)) {
                this.registerMaterialInCache(mesh);
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
            // mesh.onMaterialChangedObservable.remove(this.onMeshMaterialChanged.bind(this));
            let idx = this._transparentMeshesCache.indexOf(mesh);
            if (idx !== -1) {
                this.unregisterMaterialInCache(mesh);
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

    private registerMaterialInCache(mesh: Mesh): void {
        if (this._materialCache[mesh.uniqueId]) {
            console.error("Material is being registered for transparency but it already is.");
            return;
        }
        if (!this.shouldRenderAsTransparency(mesh.material)) {
            console.error("Material is being registered for transparency and isn't transparent.")
            return;
        }
        const cacheEntry = this.makeMaterialCacheEntry(mesh);
        if (cacheEntry) {
            this._materialCache[mesh.uniqueId] = cacheEntry;
        }
    }

    private unregisterMaterialInCache(mesh: Mesh): void {
        const cache = this._materialCache[mesh.uniqueId];
        if (cache) {
            delete this._materialCache[mesh.uniqueId];
        }
    }

    private makeMaterialCacheEntry(mesh: Mesh): Nullable<MaterialCacheEntry> {
        const cacheEntry = new MaterialCacheEntry();
        if (!mesh.material) {
            return null;
        }
        const material = mesh.material as PBRMaterial;
        if (!material.subSurface.isRefractionEnabled) {
            material.subSurface.refractionIntensity = 0;
        }
        cacheEntry.regularMaterial = material;
        const gbuffer_pass_1 = material.clone(`${mesh.material.name}_gbuffer1`);
        gbuffer_pass_1.getRenderTargetTextures = null;
        gbuffer_pass_1.depthPeeling.isEnabled = true;
        gbuffer_pass_1.useAdobeGBufferRendering = true;
        gbuffer_pass_1.adobeGBufferVolumeInfoEnabled = this._volumeRenderingEnabled;
        gbuffer_pass_1.depthPeeling.frontDepthTextureIsInverse = false;
        gbuffer_pass_1.backFaceCulling = false;
        gbuffer_pass_1.forceNormalForward = true;
        // If refraction is disabled, it means we're not using transmission. So, we'll set refractionIntensity to 0 so that
        // when it's enabled, it won't
        
        // TODO - Refraction gets disabled if we don't assign a refraction texture. However, we don't need
        // the refraction texture for each pass.
        gbuffer_pass_1.refractionTexture = this._scene.environmentTexture;
        
        gbuffer_pass_1.forceDepthWrite = false;
        if (gbuffer_pass_1.needAlphaBlending()) {
            // gbuffer_pass_1.subSurface.refractionIntensity = 0;
            gbuffer_pass_1.needAlphaBlending = () => false;
        }
        // material.refractionTexture = this.getFinalComposite();
        // material.transparency.refractionScale = this._options.refractionScale;
        // material.transparency.sceneScale = this._options.sceneScale;
        cacheEntry.gbufferMaterial1 = gbuffer_pass_1;
        
        // Subsequent passes use an inverse depth buffer and don't need a refraction texture.
        const gbuffer_pass_2 = gbuffer_pass_1.clone(`${mesh.material.name}_gbuffer2`);
        gbuffer_pass_2.depthPeeling.frontDepthTextureIsInverse = true;
        gbuffer_pass_2.refractionTexture = this._scene.environmentTexture; // TODO - try making this null!
        gbuffer_pass_2.getRenderTargetTextures = null;
        gbuffer_pass_2.subSurface.depthInRefractionAlpha = !this._mrtDisabled;
        if (gbuffer_pass_2.needAlphaBlending()) {
            // gbuffer_pass_2.subSurface.refractionIntensity = 0;
            gbuffer_pass_2.needAlphaBlending = () => false;
        }
        cacheEntry.gbufferMaterial2 = gbuffer_pass_2;

        // material.needAlphaBlending = () => false;
        material.forceDepthWrite = true;
        material.getRenderTargetTextures = null;
        if (material.needAlphaBlending()) {
            // material.subSurface.refractionIntensity = 0;
            // gbuffer_pass_1.getRenderTargetTextures = null;
            // material.needAlphaBlending = () => false;
            // material.linkRefractionWithTransparency = true;
            material.subSurface.treatAlphaAsClearRefraction = true;
        }

        return cacheEntry;
    }

    private _parseScene(): void {
        this._scene.meshes.forEach(this._addMesh.bind(this));
        // Listen for when a mesh is added to the scene and add it to our cache lists.
        this._scene.onNewMeshAddedObservable.add(this._addMesh.bind(this));
        // Listen for when a mesh is removed from to the scene and remove it from our cache lists.
        this._scene.onMeshRemovedObservable.add(this._removeMesh.bind(this));
    }

    // When one of the meshes in the scene has its material changed, make sure that it's in the correct cache list.
    // private onMeshMaterialChanged(mesh: AbstractMesh) {
    //     if (mesh instanceof Mesh) {
    //         let transparent_idx = this._transparentMeshesCache.indexOf(mesh);
    //         let opaque_idx = this._opaqueMeshesCache.indexOf(mesh);

    //         // If the material is transparent, make sure that it's added to the transparent list and removed from the opaque list
    //         if (this.shouldRenderAsTransparency(mesh.material)) {
    //             // this.registerMaterialInCache(mesh);
    //             if (opaque_idx !== -1) {
    //                 this._opaqueMeshesCache.splice(opaque_idx, 1);
    //                 this._transparentMeshesCache.push(mesh);
    //             } else if (transparent_idx === -1) {
    //                 this._transparentMeshesCache.push(mesh);
    //             }
    //             // If the material is opaque, make sure that it's added to the opaque list and removed from the transparent list
    //         } else {
    //             if (transparent_idx !== -1) {
    //                 // this.unregisterMaterialInCache(mesh);
    //                 this._transparentMeshesCache.splice(transparent_idx, 1);
    //                 this._opaqueMeshesCache.push(mesh);
    //             } else if (opaque_idx === -1) {
    //                 this._opaqueMeshesCache.push(mesh);
    //             }
    //         }
    //     }
    //     if (this._transparentMeshesCache.length == 0) {
    //         this.disabled = true;
    //     } else {
    //         this.disabled = false;
    //     }
    // }

    /**
    * Add another pass
    */
    private addPass(): void {

        if (this._mrtRenderTargets.length >= this._options.numPasses) {
            return;
        }
        
        if (this.disabled) {
            return;
        }

        let floatTextureType = 0;
        // if (this._scene.getEngine().getCaps().textureHalfFloatRender) {
        //     floatTextureType = Engine.TEXTURETYPE_HALF_FLOAT;
        // }
        // else if (this._scene.getEngine().getCaps().textureFloatRender) {
            floatTextureType = Engine.TEXTURETYPE_FLOAT;
        // }

        const isFirstPass = this._mrtRenderTargets.length === 0;
        const mrtIdx = this._mrtRenderTargets.length;
        // Create another pass
        const renderBufferCount = this._volumeRenderingEnabled ? 6 : 3;
        const multiRenderTarget = new MultiRenderTarget("transparency_mrt_" + mrtIdx, this._options.renderSize, renderBufferCount, this._scene, {
            defaultType: floatTextureType,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE, floatTextureType, Constants.TEXTURETYPE_UNSIGNED_BYTE, Constants.TEXTURETYPE_UNSIGNED_BYTE, Constants.TEXTURETYPE_UNSIGNED_BYTE, Constants.TEXTURETYPE_UNSIGNED_BYTE],
            samplingModes: [MultiRenderTarget.BILINEAR_SAMPLINGMODE],
            doNotChangeAspectRatio: true,
            generateMipMaps: true
        });
        multiRenderTarget.wrapU = Texture.CLAMP_ADDRESSMODE;
        multiRenderTarget.wrapV = Texture.CLAMP_ADDRESSMODE;
        multiRenderTarget.refreshRate = 1;
        multiRenderTarget.renderParticles = false;
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
            
            this._transparentMeshesCache.forEach((mesh: AbstractMesh) => {
                if (this.shouldRenderAsTransparency(mesh.material) && mesh.material instanceof PBRMaterial) {
                    const cachedMaterial = this._materialCache[mesh.uniqueId];
                    if (cachedMaterial) {
                        if (!isFirstPass) {
                            const passMaterial = cachedMaterial.gbufferMaterial2;
                            passMaterial.depthPeeling.frontDepthTexture = this._mrtRenderTargets[mrtIdx - 1].textures[1];
                            passMaterial.depthPeeling.frontDepthTextureIsInverse = true;
                            passMaterial.depthPeeling.backDepthTexture = this._opaqueDepthRenderer.getDepthMap();
                            mesh.material = passMaterial;
                        } else {
                            cachedMaterial.gbufferMaterial1.depthPeeling.frontDepthTexture = this._frontDepthRenderer.getDepthMap();
                            cachedMaterial.gbufferMaterial1.depthPeeling.backDepthTexture = this._opaqueDepthRenderer.getDepthMap();
                            mesh.material = cachedMaterial.gbufferMaterial1;
                        }
                    }
                }
            });
        });

        this._mrtRenderTargets.push(multiRenderTarget);
    }
    
    private removePass(): boolean {
        if (!this._mrtRenderTargets.length) {
            return false;
        }
        // If all passes are currently enabled, disable the last one before removing it.
        if (this._numEnabledPasses >= this._mrtRenderTargets.length) {
            this.disablePass();
        }
        const mrt = this._mrtRenderTargets.pop();
        if (mrt) {
            mrt.onBeforeRenderObservable.clear();
            mrt.onAfterRenderObservable.clear();
            mrt.dispose();
        }
        return true;
    }

    public setEnabledPasses(numPasses: number, forceCreateNewPass: boolean = false) {
        const updateOptions: Partial<IAdobeTransparencyHelperOptions> = {};
        if (this._options.numPasses < numPasses && forceCreateNewPass) {
            updateOptions.numPasses = numPasses;
            updateOptions.passesToEnable = numPasses;
            this.updateOptions(updateOptions);
        } else {
            updateOptions.passesToEnable = numPasses;
            this.updateOptions(updateOptions);
        }
    }

    // Enable another pass, if one exists.
    public enablePass(): void {
        if (this._numEnabledPasses >= this._mrtRenderTargets.length) {
            return;
        }
        // Remove existing bound callback for the last MRT.
        if (this._numEnabledPasses) {
            this._mrtRenderTargets[this._numEnabledPasses - 1].onAfterRenderObservable.removeCallback(this._onAfterLastMRTPass, this);
        }
        this._mrtRenderTargets[this._numEnabledPasses].renderList = this._transparentMeshesCache;
        // Add MRT's to render targets list.
        if (this._currentMRTIndex >= 0) {
            this._scene.customRenderTargets.splice(this._currentMRTIndex + 1, 0, this._mrtRenderTargets[this._numEnabledPasses]);
        } else {
            this._scene.customRenderTargets.push(this._mrtRenderTargets[this._numEnabledPasses]);
        }
        
        // Enable callback to update materials on the last MRT.
        this._mrtRenderTargets[this._numEnabledPasses].onAfterRenderObservable.add(this._onAfterLastMRTPass, undefined, false, this);
        this._numEnabledPasses++;
        this._currentMRTIndex++;
    }

    public disablePass(): void {
        if (this._numEnabledPasses === 0) {
            return;
        }
        // Add MRT's to render targets list.
        this._numEnabledPasses--;
        if (this._currentMRTIndex >= 0) {
            this._mrtRenderTargets[this._numEnabledPasses].onAfterRenderObservable.removeCallback(this._onAfterLastMRTPass, this);
            const removedRTs = this._scene.customRenderTargets.splice(this._currentMRTIndex, 1);
            // Clear these RT's (mainly for debugging purposes)
            removedRTs.forEach((texRT) => {
                texRT.renderList = [];
                texRT.render();
            });
            if (this._numEnabledPasses) {
                this._mrtRenderTargets[this._numEnabledPasses - 1].onAfterRenderObservable.add(this._onAfterLastMRTPass, undefined, false, this);
            }
        } else {
            throw new Error("Can't disable pass without an MRT index");
        }
        this._currentMRTIndex--;
    }

    private _onAfterLastMRTPass(eventData: number): void {
        // Disable transparent materials to output to MRT
        if (this._transparentMeshesCache) {

            this._transparentMeshesCache.forEach((mesh: AbstractMesh) => {
                if (this.shouldRenderAsTransparency(mesh.material) && mesh.material instanceof PBRMaterial) {
                    const cachedMaterial = this._materialCache[mesh.uniqueId];
                    if (cachedMaterial) {
                        const regularMaterial = cachedMaterial.regularMaterial;
                        if (regularMaterial.needAlphaBlending()) {
                            // regularMaterial.subSurface.isRefractionEnabled = true;
                            // regularMaterial.getRenderTargetTextures = null;
                            regularMaterial.forceDepthWrite = true;
                        }
                        regularMaterial.subSurface.depthInRefractionAlpha = !this._mrtDisabled;
                        regularMaterial.refractionTexture = this.getFinalComposite();
                        mesh.material = regularMaterial;
                    }
                }
            });
        }

        this._compositor.render();
    }

    /**
     * Setup the render targets according to the specified options.
     */
    private _setupRenderTargets(): void {

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
        this._opaqueRTIndex = this._scene.customRenderTargets.indexOf(this._opaqueRenderTarget);
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
            if (this._opaqueRTIndex >= 0) {
                this._scene.customRenderTargets.splice(this._opaqueRTIndex, 0, this._opaqueRenderTarget);
            } else {
                this._opaqueRTIndex = this._scene.customRenderTargets.length;
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

        let rt_idx = -1;
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
                rt_idx = this._scene.customRenderTargets.length - 1;
            }
        }

        // Before creating MRT's and depth passes, remove the existing ones.
        while (this.removePass()) {}

        // Set the "current" MRT pointer to the front depth RT so that the next enabled MRT goes right after.
        this._currentMRTIndex = rt_idx;

        this._transparentMeshesCache.forEach((mesh: AbstractMesh) => {
            if (this.shouldRenderAsTransparency(mesh.material) && mesh.material instanceof PBRMaterial) {
                mesh.material.refractionTexture = null;
            }
        });

        // Create all the render targets for the depth-peeling passes
        this._mrtRenderTargets = [];

        for (let i = 0; i < this._options.numPasses; i++) {
            this.addPass();
        }

        if (this._compositor) {
            this._compositor.dispose();
        }
        this._compositor = new AdobeTransparencyCompositor({
            renderSize: this._options.renderSize,
            passesToEnable: this._options.passesToEnable,
            volumeRendering: this._volumeRenderingEnabled,
            refractionScale: this._options.refractionScale,
            sceneScale: this._options.sceneScale }, this._scene);
        this._compositor.setBackgroundDepthTexture(this._opaqueDepthRenderer.getDepthMap());
        this._compositor.setBackgroundTexture(this._opaqueRenderTarget);
        this._compositor.setTransparentTextures(this._mrtRenderTargets);

        this._transparentMeshesCache.forEach((mesh: AbstractMesh) => {
            if (mesh.material instanceof PBRMaterial) {
                mesh.material.refractionTexture = this.getFinalComposite();
            }
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