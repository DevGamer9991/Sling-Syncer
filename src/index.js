require('dotenv').config();
const path = require('path');
const process = require('process');
const fs = require('fs').promises;
const cron = require('node-cron');
const axios = require('axios');
const http = require('http');
const url = require('url');
const open = require('open');
const destroyer = require('server-destroy');

const {OAuth2Client} = require('google-auth-library');
const {google} = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];

const slingToken = process.env.SLING_TOKEN;
const orgID = process.env.ORG_ID;
const userID = process.env.USER_ID;
const discordWebhookURL = process.env.DISCORD_WEBHOOK_URL;

const TOKEN_PATH = path.join(process.cwd(), 'auth/token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'auth/credentials.json');

async function sendDiscordMessage(message) {
    try {
        if (discordWebhookURL) {
            await axios.post(discordWebhookURL, {
                content: message
            });
        }
    } catch (error) {
        console.error('Error sending Discord message:', error);
    }
}

/**
* Create a new OAuth2Client, and go through the OAuth2 content
* workflow.  Return the full client to the callback.
*/
function getAuthenticatedClient() {
    return new Promise(async (resolve, reject) => {

        // Load client secrets from a local file.
        const keys = JSON.parse(await fs.readFile(CREDENTIALS_PATH)).installed
        // create an oAuth client to authorize the API call.  Secrets are kept in a `keys.json` file,
        // which should be downloaded from the Google Developers Console.
        const oAuth2Client = new OAuth2Client(
            keys.client_id,
            keys.client_secret,
            process.env.REDIRECT_URI
        );
    
        // Generate the url that will be used for the consent dialog.
        const authorizeUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
        });
    
        // Open an http server to accept the oauth callback. In this simple example, the
        // only request to our webserver is to /oauth2callback?code=<code>
        const server = http
            .createServer(async (req, res) => {
            try {
                if (req.url.indexOf('/') > -1) {
                // acquire the code from the querystring, and close the web server.
                const qs = new url.URL(req.url, 'http://localhost:3000')
                    .searchParams;
                const code = qs.get('code');
                console.log(`Code is ${code}`);
                res.end('Authentication successful! Please return to the console.');
                server.destroy();
    
                // Now that we have the code, use that to acquire tokens.
                const r = await oAuth2Client.getToken(code);
                // Make sure to set the credentials on the OAuth2 client.
                oAuth2Client.setCredentials(r.tokens);
                console.info('Tokens acquired.');
                resolve(oAuth2Client);
                }
            } catch (e) {
                reject(e);
            }
            })
            .listen(5369, () => {
                // open the browser to the authorize url to start the workflow
                console.log('Authorize this app by visiting this url:', authorizeUrl);
                sendDiscordMessage(`Authorize this app by visiting this url: ${authorizeUrl}`)
                open(authorizeUrl, {wait: false}).then(cp => cp.unref());
            });
        destroyer(server);
    });
  }

/**
 * Load or request or authorization to call APIs.
 *
 */
async function authorize() {
    console.log('Authorizing...');

    let oAuth2Client;
    try {
        // Check if the token file exists
        const token = await fs.readFile(TOKEN_PATH);
        oAuth2Client = new OAuth2Client();
        oAuth2Client.setCredentials(JSON.parse(token));
        console.log('Token loaded from file');
        sendDiscordMessage(`Authorized to access Google Calendar, token loaded from file`)
        
    } catch (error) {
        // If the token file doesn't exist, create a new OAuth2 client
        oAuth2Client = await getAuthenticatedClient();
        // Save the token to disk for later program executions
        await fs.writeFile(TOKEN_PATH, JSON.stringify(oAuth2Client.credentials));
        console.log('Token saved to file');
        sendDiscordMessage(`Authorized to access Google Calendar, token saved to file`)

    } 
    return oAuth2Client;
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
    try {
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
            }, async (err, res) => {
                if (err) {
                    sendDiscordMessage(`Error Creating Event for ${positionName} from ${startTime} to ${endTime}: ${err}`)
    
                    return console.log('The API returned an error: ' + err);
                }
                sendDiscordMessage(`Event created for ${positionName} from ${startTime} to ${endTime}`)
                console.log('Event created: %s', res.data.htmlLink);
            });
    
            console.log(`Event created for ${positionName} from ${startTime} to ${endTime}`);
    
            // wait 1 second before creating the next event
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } catch (error) {
        console.error(error);
        sendDiscordMessage(`Error: ${error}`)
    }
}


authorize().then((auth) => {
    main(auth);
    cron.schedule('0 0 * * *', () => {
        console.log('Running the job');

        sendDiscordMessage(`Running the job`)

        main(auth);
    });
}).catch(console.error);
