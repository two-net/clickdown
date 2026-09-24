import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { Routes, provideRouter, withHashLocation, withRouterConfig } from '@angular/router';
import { Backend } from './backend';

/** Every address shows the one shell; the Navigator reads where you are from it. */
export const routes: Routes = [{ path: '**', children: [] }];

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Settings (animations on/off) come from the config file, via the server.
    provideAppInitializer(() => inject(Backend).loadSettings()),
    // Where you are goes after the # (/#/workspace/9/space/5): the server only ever serves /, and Back, Forward,
    // reloads and bookmarks still open the right screen. The one address no route matches, with an outlet in
    // parentheses, stays where it was without a console error.
    provideRouter(routes, withHashLocation(), withRouterConfig({ resolveNavigationPromiseOnError: true })),
  ],
};
