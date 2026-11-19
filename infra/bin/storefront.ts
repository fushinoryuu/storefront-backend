import { InvalidAlarmRecipientError } from '../lib/config/alarm-recipients';
import { loadLocalEnv } from '../lib/config/local-env';
import { UnknownStageError } from '../lib/config/stages';
import { createApp } from '../lib/app';

// Values that stay on this machine, such as the alarm addresses, can be in the `.env` file that git ignores.
loadLocalEnv();

try {
    createApp().synth();
} catch (error) {
    // A missing or misspelled stage, or a mistyped alarm address, is a usage mistake, so skip the stack trace.
    if (error instanceof UnknownStageError || error instanceof InvalidAlarmRecipientError) {
        console.error(error.message);
        process.exit(1);
    }
    throw error;
}
