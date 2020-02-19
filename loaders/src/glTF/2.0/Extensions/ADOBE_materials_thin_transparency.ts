import { Nullable } from "babylonjs/types";
import { Color3 } from "babylonjs/Maths/math";
// import { Mesh } from "babylonjs/Meshes/mesh";
// import { TransformNode } from "babylonjs/Meshes/transformNode";
import { PBRMaterial } from "babylonjs/Materials/PBR/pbrMaterial";
import { Material } from "babylonjs/Materials/material";
import { BaseTexture } from "babylonjs/Materials/Textures/baseTexture";

// import { IChildRootProperty } from "babylonjs-gltf2interface";
import { IMaterial, ITextureInfo } from "../glTFLoaderInterfaces";
import { IGLTFLoaderExtension } from "../glTFLoaderExtension";
import { GLTFLoader } from "../glTFLoader";
// import { PBRBaseMaterial } from 'babylonjs/Materials/PBR/pbrBaseMaterial';

const NAME = "ADOBE_materials_thin_transparency";

interface IAdobeMaterialsThinTransparency {
    transmissionFactor?: number;
    transmissionTexture?: ITextureInfo;
    ior?: number;
    density?: number;
    interiorColor?: number[];
}

export class ADOBE_materials_thin_transparency implements IGLTFLoaderExtension {
    /** The name of this extension. */
    public readonly name = NAME;

    private _loader: GLTFLoader;

    /** Defines whether this extension is enabled. */
    public enabled: boolean;

    constructor(loader: GLTFLoader) {
        this._loader = loader;
        (loader as any)._parent.transparencyAsCoverage = true;
        this.enabled = this._loader.isExtensionUsed(NAME);
    }

    /** @hidden */
    public onLoading(): void {
        const extensions = this._loader.gltf.extensions;
        if (extensions && extensions[this.name]) {
            // const extension = extensions[this.name] as IAdobeMaterialsThinTransparency;
            // this._lights = extension.lights;
        }
    }

    /** @hidden */
    public dispose() {
        delete this._loader;
        // delete this._lights;
    }

    /** @hidden */
    public loadMaterialPropertiesAsync(context: string, material: IMaterial, babylonMaterial: Material): Nullable<Promise<void>> {
        return GLTFLoader.LoadExtensionAsync<IAdobeMaterialsThinTransparency>(context, material, this.name, (extensionContext, extension) => {
            const promises = new Array<Promise<any>>();
            promises.push(this._loader.loadMaterialBasePropertiesAsync(context, material, babylonMaterial));
            promises.push(this._loader.loadMaterialPropertiesAsync(context, material, babylonMaterial));
            promises.push(this._loadTransparentPropertiesAsync(context, material, babylonMaterial, extension));
            return Promise.all(promises).then(() => { });
        });
    }

    private _loadTransparentPropertiesAsync(context: string, material: IMaterial, babylonMaterial: Material, extension: IAdobeMaterialsThinTransparency): Promise<void> {
        if (!(babylonMaterial instanceof PBRMaterial)) {
            throw new Error(`${context}: Material type not supported`);
        }
        // const promises = [];
        // if (material.extensions && material.extensions.ADOBE_materials_thin_transparency) {

        // console.log(extension);
        // console.log(babylonMaterial);
        // console.log(material.extras);

        // const transparencyExtension = material.extensions.ADOBE_materials_thin_transparency;
        let pbrMaterial = babylonMaterial as PBRMaterial;
        
        pbrMaterial.subSurface.isRefractionEnabled = true;
        // pbrMaterial.transparencyMode = PBRBaseMaterial.PBRMATERIAL_OPAQUE;
        // pbrMaterial.backFaceCulling = false;
        // pbrMaterial.twoSidedLighting = true;
        pbrMaterial.separateCullingPass = false;
        pbrMaterial.enableSpecularAntiAliasing = true;
        pbrMaterial.subSurface.isVolumeThicknessEnabled = true;

        // Don't let the material gather RT's because, if it does, the scene will try to render the RT for the refractionTexture.
        // TODO - don't do this if not using depth peeling?
        pbrMaterial.getRenderTargetTextures = null;
        pbrMaterial.subSurface.useAlbedoToTintRefraction = true;

        if (extension.transmissionFactor !== undefined) {
            pbrMaterial.subSurface.refractionIntensity = extension.transmissionFactor;
        } else {
            pbrMaterial.subSurface.refractionIntensity = 1.0;
        }

        if (extension.ior !== undefined) {
            pbrMaterial.subSurface.indexOfRefraction = extension.ior;
        }

        if (material.extras && material.extras.ADOBE_transparency && material.extras.ADOBE_transparency.density) {
            const volume_info = material.extras.ADOBE_transparency;
            pbrMaterial.subSurface.isVolumeThicknessEnabled = true;
            pbrMaterial.subSurface.isScatteringEnabled = true;
            pbrMaterial.subSurface.maximumThickness = 1.0;
            pbrMaterial.subSurface.minimumThickness = 0.0;
            if (volume_info.interiorColor !== undefined) {
                // pbrMaterial.subSurface.tintColor = Color3.FromArray(volume_info.interiorColor);
                pbrMaterial.subSurface.scatterColor = Color3.FromArray(volume_info.interiorColor);
                pbrMaterial.subSurface.scatterColor.clampToRef(0.01, 0.955, pbrMaterial.subSurface.tintColor);
                // pbrMaterial.subSurface.scatterColor.
                // vec3 clamped_color = clamp(vInteriorTransparency.rgb, vec3(0.000303527, 0.000303527, 0.000303527), vec3(0.991102, 0.991102, 0.991102));

                // Conversion to distance is -ln(color) / density
                // Factor of 100 is used to convert from cm to m.
                // pbrMaterial.subSurface.tintColorAtDistance = -Math.log(volume_info.density) / 10;
                pbrMaterial.subSurface.tintColorAtDistance = -Math.log(1.0 - pbrMaterial.subSurface.tintColor.toLuminance()) / (volume_info.density * 35);
                // pbrMaterial.subSurface.tintColorAtDistance *= pbrMaterial.subSurface.tintColorAtDistance;
                pbrMaterial.subSurface.scatteringIntensity = Math.min(1.0 * (volume_info.density * 20), 1.0);
            }
        }
        

        if (extension.transmissionTexture) {
            return this._loader.loadTextureInfoAsync(context, extension.transmissionTexture)
                .then((texture: BaseTexture) => {
                    pbrMaterial.subSurface.thicknessTexture = texture;
                    pbrMaterial.subSurface.useMaskFromThicknessTexture = true;
                });
        } else {
            return Promise.resolve();
        }
    }
}

GLTFLoader.RegisterExtension(NAME, (loader) => new ADOBE_materials_thin_transparency(loader));