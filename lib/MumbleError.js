/**
 * Error class for delivering server errors.
 *
 * @param {String} name - Error type name.
 * @param {Object} data
 */
class MumbleError extends Error {
    constructor(name, data) {
        super();

        Error.captureStackTrace(this, MumbleError);

        this.name = 'MumbleError';

        // Construct the error message.

        // Start with the default message common for all errors.
        this.message = `'${name}' message received from the Mumble server`;

        // Check if the error data contained textual reason.
        const reason = data.details || data.reason;

        if (reason) {
            // The reason was present in the data. Insert it on its own line.
            this.message += `:\n"${reason}"\n\n`;
        } else {
            // No reason. Finish the message line.
            this.message += '. ';
        }

        // Finish the error message with instructions to check the 'data' field.
        this.message += 'See \'data\' for details.';
    }
}

module.exports = MumbleError;
