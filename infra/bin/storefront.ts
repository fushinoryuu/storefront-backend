import { UnknownStageError } from '../lib/config/stages';
import { createApp } from '../lib/app';

try {
  createApp().synth();
} catch (error) {
  // A missing or misspelled stage is a usage mistake, so skip the stack trace.
  if (error instanceof UnknownStageError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
