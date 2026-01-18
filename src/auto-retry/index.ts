import { createScriptIdDiv, teleportStyle } from '@util/script';
import SettingsPanel from './SettingsPanel.vue';
import { useSettingsStore } from './settings';
import { install, uninstall } from './interceptor';

$(() => {
  const pinia = createPinia();
  const app = createApp(SettingsPanel).use(pinia);

  const $app = createScriptIdDiv().appendTo('#extensions_settings2');
  app.mount($app[0]);

  const { destroy: destroyStyle } = teleportStyle();

  const store = useSettingsStore(pinia);

  install();

  replaceScriptButtons([{ name: 'Toggle Auto-Retry', visible: true }]);

  eventOn(getButtonEvent('Toggle Auto-Retry'), () => {
    store.toggle();
    if (store.settings.enabled) {
      toastr.success('Auto-Retry Enabled');
    } else {
      toastr.warning('Auto-Retry Disabled');
    }
  });

  $(window).on('pagehide', () => {
    uninstall();
    app.unmount();
    $app.remove();
    destroyStyle();
  });
});
