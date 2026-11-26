import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';
import { startTelemetry } from './app/core/telemetry/telemetry';

startTelemetry();

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
