import { defineVitestConfig } from '@papercusp/test-config';

// Runtime label is recorded by the shared reporter; a filename alone is not layer evidence.
export default defineVitestConfig({ layer: 'integration' });
