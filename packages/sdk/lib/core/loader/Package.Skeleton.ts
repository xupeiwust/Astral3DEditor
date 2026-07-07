/**
 * @author MaHaiBing
 * @email  mlt131220@163.com
 * @date   2024/8/3 22:49
 * @description Package 解包骨骼处理
 */
import type { Bone, Object3D, SkinnedMesh } from "three";

/**
 * Package 分包解包期间维护 Bone 与 Skeleton 的延迟绑定
 * 生命周期绑定到一次 Package 解包流程，解包结束后必须调用 clear 释放缓存引用
 */
export class PackageSkeleton {
    // 场景内已经解包完成的真实 Bone
    private boneMap = new Map<string, Bone>();
    // 场景内已经建立的 Skeleton 绑定关系
    private skeletonsMap  = new Map<string, ITHREEScene.SkeletonBinding>();
    // ObjectLoader 先创建占位 Bone 时，记录后续需要按索引回填的位置
    private unMatchBoneMap  = new Map<string, ITHREEScene.PendingSkeletonBone[]>();

    constructor() {
    }

    /**
     * 刷新 Skeleton 绑定后的 SkinnedMesh 状态
     * @param binding 当前 Skeleton 和引用它的 SkinnedMesh 绑定关系
     * @returns {void}
     */
    private refreshSkinnedMeshes(binding: ITHREEScene.SkeletonBinding): void {
        binding.skeleton.update();

        binding.skinnedMeshes.forEach(skinnedMesh => {
            const skinnedMeshBounds = skinnedMesh as unknown as ITHREEScene.SkinnedMeshBounds;
            skinnedMesh.skeleton = binding.skeleton;
            // SkinnedMesh 的包围体会参与视锥裁剪，骨骼替换后必须让 three 重新计算
            skinnedMeshBounds.boundingSphere = null;
            skinnedMeshBounds.boundingBox = null;
        });
    }

    /**
     * 收集当前分包内引用指定 Skeleton 的 SkinnedMesh
     * @param group 当前已解包的对象树
     * @param skeletonUuid Skeleton uuid
     * @param binding 已存在的 Skeleton 绑定记录
     * @returns {ITHREEScene.SkeletonBinding | undefined} 更新后的 Skeleton 绑定记录
     */
    private collectSkeletonBinding(
        group: Object3D,
        skeletonUuid: string,
        binding?: ITHREEScene.SkeletonBinding
    ): ITHREEScene.SkeletonBinding | undefined {
        const skinnedMeshes = binding?.skinnedMeshes || [];
        let runtimeSkeleton = binding?.skeleton;

        group.traverse(object => {
            const skinnedMesh = object as SkinnedMesh;
            const skeleton = skinnedMesh.skeleton;
            if (!skeleton?.uuid || skeleton.uuid !== skeletonUuid) return;

            runtimeSkeleton = runtimeSkeleton || skeleton;
            if (!skinnedMeshes.includes(skinnedMesh)) {
                skinnedMeshes.push(skinnedMesh);
            }
        });

        if (!runtimeSkeleton || skinnedMeshes.length === 0) return;

        return {
            skeleton: runtimeSkeleton,
            skinnedMeshes,
        };
    }

    /**
     * 登记当前分包已经加载完成的真实 Bone，并修复等待中的 Skeleton
     * @param bones 当前分包对象树中的 Bone 列表
     */
    addBones(bones: Bone[]): void {
        bones.forEach(bone => {
            if (this.boneMap.has(bone.uuid)) return;

            this.boneMap.set(bone.uuid,bone);

            if (this.unMatchBoneMap.has(bone.uuid)) {
                const pendingBones = this.unMatchBoneMap.get(bone.uuid) as ITHREEScene.PendingSkeletonBone[];

                pendingBones.forEach(pendingBone => {
                    pendingBone.skeleton.bones[pendingBone.boneIndex] = bone;
                    this.refreshSkinnedMeshes({
                        skeleton: pendingBone.skeleton,
                        skinnedMeshes: pendingBone.skinnedMeshes,
                    });
                });

                this.unMatchBoneMap.delete(bone.uuid);
            }
        });
    }

    /**
     * 处理当前分包内的 Skeleton JSON，保证骨骼按原始索引回填
     * @param skeletons 当前分包内的 Skeleton JSON 列表
     * @param group 当前已解包的对象树
     */
    handleSkeletons(skeletons: import("three").SkeletonJSON[],group: Object3D): void {
        skeletons.forEach(skeleton => {
            const binding = this.collectSkeletonBinding(group, skeleton.uuid, this.skeletonsMap.get(skeleton.uuid));
            if (!binding) return;

            const bonesUuid: string[] = skeleton.bones.slice();

            bonesUuid.forEach((boneUuid, boneIndex) => {
                const matchedBone = this.boneMap.get(boneUuid);
                if (matchedBone) {
                    binding.skeleton.bones[boneIndex] = matchedBone;
                    return;
                }

                const currentBone = binding.skeleton.bones[boneIndex];
                const currentBoneUserData = currentBone?.userData as ITHREEScene.SkeletonPlaceholderBoneUserData | undefined;
                if (currentBone?.uuid === boneUuid && currentBoneUserData?.__astralPackageSkeletonPlaceholder !== true) {
                    this.boneMap.set(boneUuid, currentBone);
                    return;
                }

                const pendingBones = this.unMatchBoneMap.get(boneUuid) || [];
                if (!pendingBones.some(pendingBone => pendingBone.skeleton === binding.skeleton && pendingBone.boneIndex === boneIndex)) {
                    pendingBones.push({
                        skeleton: binding.skeleton,
                        boneIndex,
                        skinnedMeshes: binding.skinnedMeshes,
                    });
                }

                this.unMatchBoneMap.set(boneUuid,pendingBones);
            });

            this.refreshSkinnedMeshes(binding);
            this.skeletonsMap.set(skeleton.uuid,binding);
        });
    }

    /**
     * 清理解包过程缓存，避免跨场景复用骨骼状态
     * @returns {void}
     */
    clear(): void {
        this.boneMap.clear();
        this.skeletonsMap.clear();
        this.unMatchBoneMap.clear();
    }
}