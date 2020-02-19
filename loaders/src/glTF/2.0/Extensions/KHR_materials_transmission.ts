import { Nullable } from "babylonjs/types";
// import { Color3 } from "babylonjs/Maths/math";
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

const NAME = "KHR_materials_transmission";

interface IMaterialsTransmission {
    transmissionFactor?: number;
    transmissionTexture?: ITextureInfo;
}

export class KHR_materials_transmission implements IGLTFLoaderExtension {
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
            // const extension = extensions[this.name] as IMaterialsTransmission;
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
        return GLTFLoader.LoadExtensionAsync<IMaterialsTransmission>(context, material, this.name, (extensionContext, extension) => {
            console.log(extensionContext);
            const promises = new Array<Promise<any>>();
            promises.push(this._loader.loadMaterialBasePropertiesAsync(context, material, babylonMaterial));
            promises.push(this._loader.loadMaterialPropertiesAsync(context, material, babylonMaterial));
            promises.push(this._loadTransparentPropertiesAsync(context, material, babylonMaterial, extension));
            return Promise.all(promises).then(() => { });
        });
    }

    private _loadTransparentPropertiesAsync(context: string, material: IMaterial, babylonMaterial: Material, extension: IMaterialsTransmission): Promise<void> {
        if (!(babylonMaterial instanceof PBRMaterial)) {
            throw new Error(`${context}: Material type not supported`);
        }
        // const promises = [];
        // if (material.extensions && material.extensions.KHR_materials_transmission) {

        // console.log(extension);
        // console.log(babylonMaterial);
        console.log(material.extras);

        // const transparencyExtension = material.extensions.KHR_materials_transmission;
        let pbrMaterial = babylonMaterial as PBRMaterial;
        
        pbrMaterial.subSurface.isRefractionEnabled = true;
        // pbrMaterial.transparencyMode = PBRBaseMaterial.PBRMATERIAL_OPAQUE;
        // pbrMaterial.subSurface.tintColor = pbrMaterial.albedoColor;

        pbrMaterial.backFaceCulling = true;
        // pbrMaterial.twoSidedLighting = true;
        pbrMaterial.separateCullingPass = false;
        pbrMaterial.enableSpecularAntiAliasing = true;
        pbrMaterial.subSurface.useAlbedoToTintRefraction = true;

        // Don't let the material gather RT's because, if it does, the scene will try to render the RT for the refractionTexture.
        // TODO - don't do this if not using depth peeling?
        pbrMaterial.getRenderTargetTextures = null;

        if (extension.transmissionFactor !== undefined) {
            pbrMaterial.subSurface.refractionIntensity = extension.transmissionFactor;
        } else {
            pbrMaterial.subSurface.refractionIntensity = 1.0;
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

GLTFLoader.RegisterExtension(NAME, (loader) => new KHR_materials_transmission(loader));