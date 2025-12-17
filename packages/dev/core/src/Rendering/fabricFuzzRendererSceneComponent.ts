import type { Nullable } from "../types";
import { Scene } from "../scene";
import type { ISceneComponent } from "../sceneComponent";
import { SceneComponentConstants } from "../sceneComponent";
import { FabricFuzzRenderer } from "./fabricFuzzRenderer";

declare module "../scene" {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    export interface Scene {
        /** @internal (Backing field) */
        _fabricFuzzRenderer: Nullable<FabricFuzzRenderer>;

        /**
         * Gets or Sets the current fabric fuzz renderer associated to the scene.
         */
        fabricFuzzRenderer: Nullable<FabricFuzzRenderer>;

        /**
         * Enables a FabricFuzzRenderer and associates it with the scene
         * @returns the FabricFuzzRenderer
         */
        enableFabricFuzzRenderer(maxFibers: number): Nullable<FabricFuzzRenderer>;
        /**
         * Disables the FabricFuzzRenderer associated with the scene
         */
        disableFabricFuzzRenderer(): void;
    }
}

Object.defineProperty(Scene.prototype, "fabricFuzzRenderer", {
    get: function (this: Scene) {
        return this._fabricFuzzRenderer;
    },
    set: function (this: Scene, value: Nullable<FabricFuzzRenderer>) {
        if (value && value.isSupported) {
            this._fabricFuzzRenderer = value;
        }
    },
    enumerable: true,
    configurable: true,
});

Scene.prototype.enableFabricFuzzRenderer = function (maxFibers: number = 65536): Nullable<FabricFuzzRenderer> {
    if (this._fabricFuzzRenderer) {
        return this._fabricFuzzRenderer;
    }

    this._fabricFuzzRenderer = new FabricFuzzRenderer(this, maxFibers);
    if (!this._fabricFuzzRenderer.isSupported) {
        this._fabricFuzzRenderer = null;
    }

    return this._fabricFuzzRenderer;
};

Scene.prototype.disableFabricFuzzRenderer = function (): void {
    if (!this._fabricFuzzRenderer) {
        return;
    }

    this._fabricFuzzRenderer.dispose();
    this._fabricFuzzRenderer = null;
};

/**
 * Defines the Fabric Fuzz scene component responsible to manage fabric fuzz effects
 * in a given scene.
 */
export class FabricFuzzSceneComponent implements ISceneComponent {
    /**
     * The component name helpful to identify the component in the list of scene components.
     */
    public readonly name = SceneComponentConstants.NAME_FABRICFUZZRENDERER;

    /**
     * The scene the component belongs to.
     */
    public scene: Scene;

    /**
     * Creates a new instance of the component for the given scene
     * @param scene Defines the scene to register the component in
     */
    constructor(scene: Scene) {
        this.scene = scene;
    }

    /**
     * Registers the component in a given scene
     */
    public register(): void {
        // Nothing to do for this component
    }

    /**
     * Rebuilds the elements related to this component in case of
     * context lost for instance.
     */
    public rebuild(): void {
        // Nothing to do for this component
    }

    /**
     * Disposes the component and the associated resources
     */
    public dispose(): void {
        // Nothing to do for this component
    }
}
