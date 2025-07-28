<script setup lang="ts">
import { ref, watch,onMounted } from 'vue';
import {t} from "@/language";
import { usePreviewOperationStore } from "@/store/modules/previewOperation";
import {MenuOperation} from "@/utils/preview/menuOperation";
import { useAddSignal } from "@/hooks/useSignal";

const operationStore = usePreviewOperationStore();

const showModal = ref(false);

watch(() => operationStore.menuList.explode.active, (newVal:boolean) => {
  showModal.value = newVal;
})

function handleChange(){
  if(!MenuOperation.explodeModel) return;

  MenuOperation.Explode.explodeModel(MenuOperation.explodeModel,operationStore.explodeScalar);
}

function handleClose(){
  showModal.value = false;
}

onMounted(() => {
  useAddSignal("objectSelected",(object) => {
    if(!operationStore.menuList.explode.active) return;

    // 点击的模型不是爆炸模型也不是爆炸模型的子级则取消爆炸
    if(object !== MenuOperation.explodeModel && object?.isAncestor(MenuOperation.explodeModel)){
      MenuOperation.explode();
    }
  })
})
</script>

<template>
  <n-card v-if="showModal" :title="t('preview.Explode')" closable @close="handleClose" size="small" :segmented="{
      content: true,
      footer: 'soft',
    }">
    <div class="flex w-full">
      <span class="w-30%">{{ t("preview.Explode scalar") }}</span>
      <n-slider v-model:value="operationStore.explodeScalar" placement="top" :step="0.1" :min="0" :max="10"
                class="w-50%" @update:value="handleChange" />
      <n-text code class="w-18% ml-2% text-align-center">{{operationStore.explodeScalar}}</n-text>
    </div>
  </n-card>
</template>

<style scoped lang="less">

</style>