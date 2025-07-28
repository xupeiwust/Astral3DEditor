import * as THREE from 'three';
import { useFullscreen } from 'vue-hooks-plus';
import {
    IPreviewOperation,
    usePreviewOperationStore,
    usePreviewOperationStoreWithOut
} from "@/store/modules/previewOperation";
import { MeasureMode } from "@/core/utils/Measure";
import { ModelExplode } from "@/core/utils/ModelExplode";
import {t} from "@/language";

/**
 * @author ErSan
 * @email  mlt131220@163.com
 * @date   2024/8/22
 * @description
 */
const operationStore = usePreviewOperationStoreWithOut();

export class MenuOperation {
    // 模型爆炸专用图层
    static explodeLayer = 10;

    // 当前爆炸的模型
    static explodeModel: THREE.Object3D | null = null;

    // 爆炸类
    static _explode: ModelExplode | null = null;

    static get Explode(): ModelExplode {
        if (!MenuOperation._explode) {
            MenuOperation._explode = new ModelExplode();
        }

        return MenuOperation._explode;
    }

    static Init(key: string) {
        if (MenuOperation[key]) {
            MenuOperation[key]();
        } else {
            window.$message?.warning("相关模块正在开发中...")
        }
    }

    static toHome() {
        window.viewer.modules.operation.resetCameraView();
    }

    static autoRotate() {
        operationStore.menuList.autoRotate.active = !operationStore.menuList.autoRotate.active;
    }

    static cutting() {
        operationStore.menuList.cutting.active = !operationStore.menuList.cutting.active;

        if (operationStore.menuList.cutting.active) {
            window.viewer.modules.clippedEdges.open();
        } else {
            window.viewer.modules.clippedEdges.close();
        }
    }

    // 测距
    static distance() {
        // 上一个测量也许未完成
        if (!window.viewer.modules.measure.isCompleted) {
            window.viewer.modules.measure.complete();
        }

        window.viewer.modules.measure.mode = MeasureMode.Distance;
        window.viewer.modules.measure.open();

        operationStore.menuList.measure.active = true;
    }

    // 测角度
    static angle() {
        if (!window.viewer.modules.measure.isCompleted) {
            window.viewer.modules.measure.complete();
        }

        window.viewer.modules.measure.mode = MeasureMode.Angle;
        window.viewer.modules.measure.open();

        operationStore.menuList.measure.active = true;
    }

    // 测面积
    static area() {
        if (!window.viewer.modules.measure.isCompleted) {
            window.viewer.modules.measure.complete();
        }

        window.viewer.modules.measure.mode = MeasureMode.Area;
        window.viewer.modules.measure.open();

        operationStore.menuList.measure.active = true;
    }

    // 清除测量结果
    static clearMeasure() {
        (<{ [key: string]: IPreviewOperation }>usePreviewOperationStore().menuList.measure.children).clearMeasure.disabled = true;
        window.viewer.modules.measure.dispose();

        operationStore.menuList.measure.active = false;
    }

    // 爆炸
    static explode() {
        if (!window.editor.selected && !MenuOperation.explodeModel) {
            window.$message?.warning(t("prompt['No object selected.']"));
            return;
        }

        operationStore.menuList.explode.active = !operationStore.menuList.explode.active;

        if (operationStore.menuList.explode.active) {
            if (!window.editor.selected) return;

            window.editor.selected.traverse(obj => obj.layers.set(MenuOperation.explodeLayer));
            window.viewer.camera.layers.set(MenuOperation.explodeLayer);

            MenuOperation.Explode.explodeModel(window.editor.selected, operationStore.explodeScalar);
            MenuOperation.explodeModel = window.editor.selected;
        } else {
            if (!MenuOperation.explodeModel) return;

            MenuOperation.explodeModel.traverse(obj => obj.layers.set(0));
            window.viewer.camera.layers.set(0);

            MenuOperation.Explode.restore();

            MenuOperation.explodeModel = null;
        }
    }

    // 漫游
    static roaming() {
        if (!window.viewer.modules.roaming) return;

        operationStore.menuList.roaming.active = !operationStore.menuList.roaming.active;

        if (operationStore.menuList.roaming.active) {
            window.viewer.modules.operation.enterRoaming();
        } else {
            window.viewer.modules.operation.leaveRoaming();
        }
    }

    static miniMap() {
        if (window.viewer.modules.miniMap.isShow) {
            operationStore.menuList.miniMap.active = false;
            window.viewer.modules.miniMap.close();
        } else {
            operationStore.menuList.miniMap.active = true;
            window.viewer.modules.miniMap.open();
        }
    }

    static fullscreen() {
        const [, { enterFullscreen }] = useFullscreen();

        operationStore.menuList.fullscreen.show = false;
        operationStore.menuList.exitFullscreen.show = true;

        enterFullscreen();
    }

    static exitFullscreen() {
        const [, { exitFullscreen }] = useFullscreen();

        operationStore.menuList.fullscreen.show = true;
        operationStore.menuList.exitFullscreen.show = false;

        exitFullscreen();
    }
}