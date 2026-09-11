import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { Backend } from './backend';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Settings (animations on/off) come from the config file, via the server.
    provideAppInitializer(() => inject(Backend).loadSettings()),
  ],
};
