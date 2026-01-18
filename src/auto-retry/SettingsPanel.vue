<template>
  <div class="auto-retry-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Auto-Retry Settings</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="flex-container flexFlowColumn">
          <div class="flex-container">
            <input id="auto-retry-enabled" v-model="settings.enabled" type="checkbox" />
            <label for="auto-retry-enabled">Enable Auto-Retry</label>
          </div>

          <hr class="sysHR" />

          <h4>Retry Configuration</h4>

          <div class="flex-container">
            <label for="auto-retry-max-retries">Max Retries:</label>
            <input
              id="auto-retry-max-retries"
              v-model.number="settings.maxRetries"
              type="number"
              min="1"
              max="20"
              class="text_pole"
            />
          </div>

          <div class="flex-container">
            <label for="auto-retry-delay">Retry Delay (ms):</label>
            <input
              id="auto-retry-delay"
              v-model.number="settings.retryDelayMs"
              type="number"
              min="100"
              max="60000"
              class="text_pole"
            />
          </div>

          <div class="flex-container">
            <label for="auto-retry-multiplier">Delay Multiplier:</label>
            <input
              id="auto-retry-multiplier"
              v-model.number="settings.retryDelayMultiplier"
              type="number"
              min="1"
              max="5"
              step="0.1"
              class="text_pole"
            />
          </div>

          <hr class="sysHR" />

          <h4>Rate Limit (429) Configuration</h4>

          <div class="flex-container">
            <label for="auto-retry-rate-limit-delay">Rate Limit Delay (ms):</label>
            <input
              id="auto-retry-rate-limit-delay"
              v-model.number="settings.rateLimitDelayMs"
              type="number"
              min="1000"
              max="300000"
              class="text_pole"
            />
          </div>

          <div class="flex-container">
            <label for="auto-retry-rate-limit-max">Rate Limit Max Retries:</label>
            <input
              id="auto-retry-rate-limit-max"
              v-model.number="settings.rateLimitMaxRetries"
              type="number"
              min="1"
              max="10"
              class="text_pole"
            />
          </div>

          <hr class="sysHR" />

          <h4>Timeout Configuration</h4>

          <div class="flex-container">
            <label for="auto-retry-streaming-timeout">Streaming Timeout (ms):</label>
            <input
              id="auto-retry-streaming-timeout"
              v-model.number="settings.streamingTimeoutMs"
              type="number"
              min="5000"
              max="300000"
              class="text_pole"
            />
          </div>

          <hr class="sysHR" />

          <h4>Content Validation</h4>

          <div class="flex-container">
            <input id="auto-retry-content-enabled" v-model="settings.requiredContentEnabled" type="checkbox" />
            <label for="auto-retry-content-enabled">Enable Content Validation</label>
          </div>

          <div v-if="settings.requiredContentEnabled" class="flex-container flexFlowColumn">
            <div class="flex-container">
              <label for="auto-retry-content-pattern">Required Pattern:</label>
              <input
                id="auto-retry-content-pattern"
                v-model="settings.requiredContentPattern"
                type="text"
                class="text_pole wide100p"
                placeholder="e.g. ```json or regex pattern"
              />
            </div>
            <div class="flex-container">
              <input id="auto-retry-content-regex" v-model="settings.requiredContentIsRegex" type="checkbox" />
              <label for="auto-retry-content-regex">Use Regex</label>
            </div>
          </div>

          <hr class="sysHR" />

          <h4>Fallback Models</h4>

          <div class="flex-container">
            <input id="auto-retry-fallback-enabled" v-model="settings.fallbackModelsEnabled" type="checkbox" />
            <label for="auto-retry-fallback-enabled">Enable Fallback Models</label>
          </div>

          <div v-if="settings.fallbackModelsEnabled" class="flex-container flexFlowColumn">
            <div v-for="(model, index) in settings.fallbackModels" :key="index" class="fallback-model-entry">
              <div class="flex-container">
                <label>API URL:</label>
                <input v-model="model.apiurl" type="text" class="text_pole wide100p" />
              </div>
              <div class="flex-container">
                <label>API Key:</label>
                <input v-model="model.key" type="password" class="text_pole wide100p" />
              </div>
              <div class="flex-container">
                <label>Model:</label>
                <input v-model="model.model" type="text" class="text_pole wide100p" />
              </div>
              <div class="flex-container">
                <label>Source:</label>
                <input v-model="model.source" type="text" class="text_pole" placeholder="openai" />
              </div>
              <input type="button" class="menu_button" value="Remove" @click="removeFallbackModel(index)" />
              <hr class="sysHR" />
            </div>
            <input type="button" class="menu_button" value="Add Fallback Model" @click="addFallbackModel" />
          </div>

          <hr class="sysHR" />

          <h4>Generation ID Filter</h4>

          <div class="flex-container">
            <input id="auto-retry-filter-enabled" v-model="settings.filterEnabled" type="checkbox" />
            <label for="auto-retry-filter-enabled">Enable Filter</label>
          </div>

          <div v-if="settings.filterEnabled" class="flex-container flexFlowColumn">
            <div class="flex-container">
              <label for="auto-retry-filter-mode">Filter Mode:</label>
              <select id="auto-retry-filter-mode" v-model="settings.filterMode" class="text_pole">
                <option value="blacklist">Blacklist (exclude listed)</option>
                <option value="whitelist">Whitelist (only listed)</option>
              </select>
            </div>
            <div class="flex-container">
              <label for="auto-retry-filter-ids">Generation IDs (comma-separated):</label>
              <input
                id="auto-retry-filter-ids"
                v-model="filterIdsString"
                type="text"
                class="text_pole wide100p"
                placeholder="e.g. background-summary, auto-continue"
              />
            </div>
          </div>

          <hr class="sysHR" />

          <h4>Notifications</h4>

          <div class="flex-container">
            <input id="auto-retry-toast-retry" v-model="settings.showRetryToast" type="checkbox" />
            <label for="auto-retry-toast-retry">Show Retry Toast</label>
          </div>

          <div class="flex-container">
            <input id="auto-retry-toast-success" v-model="settings.showSuccessToast" type="checkbox" />
            <label for="auto-retry-toast-success">Show Success Toast</label>
          </div>

          <div class="flex-container">
            <input id="auto-retry-toast-failure" v-model="settings.showFailureToast" type="checkbox" />
            <label for="auto-retry-toast-failure">Show Failure Toast</label>
          </div>

          <hr class="sysHR" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useSettingsStore } from './settings';

const store = useSettingsStore();
const { settings } = storeToRefs(store);

const filterIdsString = computed({
  get: () => settings.value.filterGenerationIds.join(', '),
  set: (val: string) => {
    settings.value.filterGenerationIds = val
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  },
});

function addFallbackModel() {
  settings.value.fallbackModels.push({
    apiurl: '',
    key: '',
    model: '',
    source: 'openai',
  });
}

function removeFallbackModel(index: number) {
  settings.value.fallbackModels.splice(index, 1);
}
</script>

<style scoped>
.auto-retry-settings {
  margin-bottom: 10px;
}

.auto-retry-settings h4 {
  margin: 10px 0 5px 0;
  font-weight: bold;
}

.auto-retry-settings .flex-container {
  margin-bottom: 5px;
}

.auto-retry-settings label {
  min-width: 150px;
}

.fallback-model-entry {
  padding: 10px;
  margin: 5px 0;
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 5px;
}
</style>
