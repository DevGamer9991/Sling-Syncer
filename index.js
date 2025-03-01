require('dotenv').config();
const path = require('path');
const process = require('process');
const fs = require('fs').promises;
const cron = require('node-cron');
const axios = require('axios');

const {authenticate} = require('@google-cloud/local-auth');
const {google} = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];

const slingToken = process.env.SLING_TOKEN;
const orgID = process.env.ORG_ID;
const userID = process.env.USER_ID;

const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

let auth;

/**
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
async function loadSavedCredentialsIfExist() {
    try {
        const content = await fs.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
    } catch (err) {
        return null;
    }
}

/**
 * Serializes credentials to a file compatible with GoogleAuth.fromJSON.
 *
 * @param {OAuth2Client} client
 * @return {Promise<void>}
 */
async function saveCredentials(client) {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Load or request or authorization to call APIs.
 *
 */
async function authorize() {
    let client = await loadSavedCredentialsIfExist();
    if (client) {
        return client;
    }
    client = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
    });
    if (client.credentials) {
        await saveCredentials(client);
    } else {
        console.log('Authorization URL:', client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
        }));
    }
    return client;
}


async function getShiftData(referenceDate, shiftData = []) {
    try {
        const { data } = await axios.get(`https://api.getsling.com/v1/shifts/next`, {
            headers: { Authorization: `${slingToken}` },
            params: { referenceDate: referenceDate.toISOString() }
        });

        // Get the end time of the current shift
        const endTime = new Date(data.dtend);

        // Schedule the next shift retrieval
        if (endTime && data.position?.id != null) {
            shiftData.push(data);
            return await getShiftData(endTime, shiftData);
        }
    } catch (error) {}
    return shiftData;
}

async function main(googleAuth) {
    const referenceDate = new Date();

    auth = googleAuth;

    var shiftData = await getShiftData(referenceDate);

    for (const shift of shiftData) {
        // pull the dates and times
        const startTime = new Date(shift.dtstart);
        const endTime = new Date(shift.dtend);

        // pull the position id
        const positionID = shift.position.id;

        var positionName = '';

        switch (positionID) {
            case 18984501:
                positionName = 'Shadowing Front Desk';
                break;
            case 1710948:
                positionName = 'Front Desk';
                break;
            case 1710949:
                positionName = 'Check In Desk';
                break;
            default:
                positionName = 'Unknown';
                break;
        }

        // take all this data and create events in the calendar
        const event = {
            summary: positionName,
            start: {
                dateTime: startTime.toISOString(),
                timeZone: 'America/New_York',
            },
            end: {
                dateTime: endTime.toISOString(),
                timeZone: 'America/New_York',
            },
            reminders: {
                useDefault: false,
                overrides: [
                    { method: 'popup', minutes: 30 },
                ],
            },
        };

        const calendar = google.calendar({ version: 'v3', auth });

        // check if the event already exists
        const events = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            timeMin: startTime.toISOString(),
            timeMax: endTime.toISOString(),
            q: positionName,
        });

        if (events.data.items.length > 0) {
            console.log(`Event for ${positionName} already exists`);
            continue;
        }

        calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
        }, (err, res) => {
            if (err) return console.log('The API returned an error: ' + err);
            console.log('Event created: %s', res.data.htmlLink);
        });

        console.log(`Event created for ${positionName} from ${startTime} to ${endTime}`);

        // wait 1 second before creating the next event
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

authorize().then((auth) => {
    main(auth);
    cron.schedule('0 0 * * *', () => {
        console.log('Running the job');
        main(auth);
    });
}).catch(console.error);