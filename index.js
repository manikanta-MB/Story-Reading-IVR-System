require('dotenv').config();
const path = require('path')
const {v4 : uuidv4} = require('uuid');
const fs = require('fs');
const https = require('follow-redirects').https;
const MP3Cutter = require('mp3-cutter');
const { getAudioDurationInSeconds } = require('get-audio-duration');
const Vonage = require('@vonage/server-sdk');
const express = require('express');
const morgan = require('morgan');
const client = require("./database");

const app = express();
const vonage = new Vonage({
  apiKey: process.env.VONAGE_API_KEY,
  apiSecret: process.env.VONAGE_API_SECRET,
  applicationId: process.env.VONAGE_APPLICATION_ID,
  privateKey: process.env.VONAGE_PRIVATE_KEY_PATH
});

app.use(morgan('tiny'));
app.use(express.json());

// Serve contents of AudioFiles folder in the /audio path
app.use('/audio', express.static(path.join(__dirname, 'AudioFiles')))

// Helper Functions

function getStreamAction(url,needBargeIn=true){
  let streamAction = {
    "action": "stream",
    "streamUrl": [url],
    "level": 1,
    "bargeIn": needBargeIn
  }
  return streamAction
}

function getTalkAction(textToTalk){
  let talkAction = {
    "action": "talk",
    "text": textToTalk,
    "bargeIn":true,
    "language":"en-IN",
    "level":1
  }
  return talkAction
}

function getInputAction(eventEndpoint,speechInput = false,maxDigits=1){
  if(speechInput){
    let inputAction = {
      "action":"input",
      "eventUrl": [
        remoteUrl+eventEndpoint
      ],
      "type": ["speech"],
      "speech": {
        "language": "en-IN",
        "startTimeout": 4,
      }
    }
    return inputAction
  }
  else{
    let inputAction = {
      "action": "input",
      "eventUrl": [
        remoteUrl+eventEndpoint
      ],
      "type": ["dtmf"],   
      "dtmf": {
        "maxDigits": maxDigits
      }  
    }
    return inputAction
  }
}

async function getStoryOptions(category=undefined){
  let result = ""
  if(category){
    result = await client.query(`select * from story_book where category_id = 
    (select id from story_category where name=$1)`,
    [category]
    )
  }
  else{
    result = await client.query(`select * from story_book`);
  }
  storyOptionsText = ""
  storyOptions = {}
  for(let i=0; i < result.rows.length; i++){
    let book = result.rows[i];
    storyOptionsText += "To select "+book.name+", press "+(i+1)+". ";
    storyOptions[(i+1).toString()] = book.name;
  }
  return "successfully fetched the stories";
}

async function getCategoryOptions(){
  const result = await client.query(`select * from story_category`);
  categoryOptionsText = ""
  categoryOptions = {}
  for(let i=0; i < result.rows.length; i++){
    let category = result.rows[i];
    categoryOptionsText += "To select " + category.name + ", press "+(i+1)+". ";
    categoryOptions[(i+1).toString()] = category.name;
  }
  return "successfully fetched the categories";
}

function storyCompleted(){
  vonage.calls.update(uuid, 
    {
      "action": "transfer",
      "destination": {
        "type": "ncco",
        "ncco": [
          {
            "action": "talk",
            "text": "Your Story was completed. Thank you for listening."
          }
        ]
      }
    },(req, res) => {
    console.log("Disconnecting...")
  });
}

function startStream(){
  isAudioActive = true;
  if(isNewStoryRequest){
    let url = "https://github.com/manikanta-MB/IVR-Audio-Recordings/blob/main/baseinput/input%202.mp3?raw=true"
    currentStoryAudioFileName = uuidv4() + ".mp3"
    https.get(url,(res) => {
    	const path = `${__dirname}/AudioFiles/${currentStoryAudioFileName}`;
    	const filePath = fs.createWriteStream(path);
    	res.pipe(filePath);
    	filePath.on('finish',() => {
    		filePath.close();
    		console.log('Download Completed');

        vonage.calls.stream.start(uuid, { stream_url: [remoteUrl + `audio/${currentStoryAudioFileName}`], level: 1 }, (err, res) => {
          if(err) { console.error(err); }
          else {
              console.log(res);
              storyPlayingStartingTime = Date.now();
              getAudioDurationInSeconds(path).then((duration) => {
                  storyTimeOutId = setTimeout(storyCompleted,(duration+1).toFixed(0)*1000);
              });
          }
        });

    	})
    });
  }
  else{
    vonage.calls.stream.start(uuid, { stream_url: [remoteUrl + `audio/${currentStoryAudioFileName}`], level: 1 }, (err, res) => {
      if(err) { console.error(err); }
      else {
          console.log(res);
          storyPlayingStartingTime = Date.now();
          const path = `${__dirname}/AudioFiles/${currentStoryAudioFileName}`;
          getAudioDurationInSeconds(path).then((duration) => {
            storyTimeOutId = setTimeout(storyCompleted,(duration+1).toFixed(0)*1000);
          });
      }
    });
  }
}

function stopStream(){
  clearTimeout(storyTimeOutId);
  isAudioActive = false;
  vonage.calls.stream.stop(uuid, (err, res) => {
    if(err) { console.error(err); }
    else {
        console.log(res);
        let timeDifference = ((Date.now() - storyPlayingStartingTime - 1000)/1000).toFixed(0);
        const currentPath = `${__dirname}/AudioFiles/${currentStoryAudioFileName}`;
        currentStoryAudioFileName = uuidv4() + ".mp3"
        const newPath = `${__dirname}/AudioFiles/${currentStoryAudioFileName}`;
        console.log("timeDifference ", timeDifference);
        MP3Cutter.cut({
          src: currentPath,
          target: newPath,
          start: timeDifference
        });
        console.log("cut completed.");
    }
  });
}

// Global Variables

let remoteUrl = "https://710e-182-74-35-130.ngrok.io/"
let mainMenuInputAction = getInputAction("main_menu_input")
let mainMenuOptions = "To List new Stories, press 2. To List Story Categories, press 3.\
                      To Request a new Story, press 4. To Repeat Current Menu, press 8.\
                      To exit from this menu, press 9."
let storyInput = getInputAction("story_input",false,2)
let categoryInput = getInputAction("category_input",false,2)
let requestStoryInput = getInputAction("request_story",true)
let storyReadingInput = getInputAction("story_reading")

let storyOptionsText = ""
let categoryOptionsText = ""
let storyOptions = {}
let categoryOptions = {}
let currentStory = undefined
let uuid = undefined
let isAudioActive = false
let isNewStoryRequest = true
let currentStoryAudioFileName = undefined
let storyPlayingStartingTime = undefined
let storyTimeOutId = undefined

app.get('/call', (req, res) => {
  vonage.calls.create({
    to: [{
      type: 'phone',
      number: req.query.to || process.env.TO_NUMBER
    }],
    from: {
      type: 'phone',
      number: process.env.VONAGE_NUMBER,
    },
    ncco: [
      getTalkAction(mainMenuOptions),
      mainMenuInputAction
    ]
  }, (err, resp) => {
    if (err)
      console.error(err);
    if (resp)
      console.log(resp);
  });
  res.send('<h1>Call was made</h1>');
});

app.post('/event', (req, res) => {
  uuid = req.body.uuid;
  console.log(req.body);
  res.status(200).send('');
});

// Level 1

app.post('/main_menu_input',(req,res) => {
  let responseObject = req.body;
  let entered_digit = responseObject.dtmf.digits;
  if(entered_digit == ''){
    let ncco = []
    ncco.push(getTalkAction("you didn't enter any digit"))
    if(currentStory){
      ncco.push(getTalkAction("To continue reading Current Story, press 1."));
    }
    ncco.push(getTalkAction(mainMenuOptions));
    ncco.push(mainMenuInputAction);
    res.json(ncco);
  }
  else{
    switch (entered_digit){
      case "1":
        break;
      case "2":
        getStoryOptions().then(
          function(value){
            console.log(value);
            console.log(storyOptionsText);
            res.json([
              getTalkAction(storyOptionsText),
              storyInput
            ]);
          },
          function(err){
            console.log(err);
          }
        );
        break;
      case "3":
        getCategoryOptions().then(
          function(value){
            console.log(value);
            console.log(categoryOptionsText);
            res.json([
              getTalkAction(categoryOptionsText),
              categoryInput
            ]);
          },
          function(err){
            console.log(err);
          }
        );
        break;
      case "4":
        res.json([
          {
          "action": "talk",
          "text": "please speak out the story name, you want"
          },
          requestStoryInput
      ]);
        break;
      case "8":
        res.json([
          getTalkAction(mainMenuOptions),
          mainMenuInputAction
        ]);
        break;
      case "9":
        res.json([]);
        break;
      default:
        let ncco = []
        ncco.push(getTalkAction("sorry, you have chosen an invalid option"))
        if(currentStory){
          ncco.push(getTalkAction("To continue reading Current Story, press 1."));
        }
        ncco.push(getTalkAction(mainMenuOptions));
        ncco.push(mainMenuInputAction);
        res.json(ncco);
    }
  }
});

// Level 2

app.post('/story_input',(req,res) => {
  let responseObject = req.body;
  // console.log(req.body);
  let entered_digit = responseObject.dtmf.digits;
  if(entered_digit == ''){
    res.json([
      getTalkAction("you didn't enter any digit"),
      getTalkAction(storyOptionsText),
      storyInput
    ]);
  }
  else{
    if(storyOptions.hasOwnProperty(entered_digit)){
      currentStory = storyOptions[entered_digit];
      isNewStoryRequest = true;
      startStream();
      isNewStoryRequest = false;
      res.json([
        {
          "action":"stream",
          "streamUrl": ["https://github.com/manikanta-MB/IVR-Audio-Recordings/blob/main/silence.mp3?raw=true"],
          "loop":0,
          "bargeIn":true
        },
        storyReadingInput
      ]);
      // res.json([
      //   {
      //     "action":"talk",
      //     "text":"you have selected "+currentStory,
      //     "language":"en-IN"
      //   }
      // ]);
    }
    else{
      res.json([
        getTalkAction("sorry, you have chosen invalid option."),
        getTalkAction(storyOptionsText),
        storyInput
      ])
    }
  }
});

app.post("/story_reading",(req,res) => {
  let responseObject = req.body;
  let entered_digit = responseObject.dtmf.digits;
  if(entered_digit == ''){
    res.json([
      {
        "action":"stream",
        "streamUrl": ["https://github.com/manikanta-MB/IVR-Audio-Recordings/blob/main/silence.mp3?raw=true"],
        "loop":0,
        "bargeIn":true
      },
      storyReadingInput
    ]);
  }
  else{
    switch(entered_digit){
      case "1":
        if(isAudioActive){
          stopStream();
        }
        else{
          startStream();
        }
        res.json([
          {
            "action":"stream",
            "streamUrl": ["https://github.com/manikanta-MB/IVR-Audio-Recordings/blob/main/silence.mp3?raw=true"],
            "loop":0,
            "bargeIn":true
          },
          storyReadingInput
        ]);
        break;
      case "2":
        break;
      default:
        res.json([
          {
            "action":"stream",
            "streamUrl": ["https://github.com/manikanta-MB/IVR-Audio-Recordings/blob/main/silence.mp3?raw=true"],
            "loop":0,
            "bargeIn":true
          },
          storyReadingInput
        ]);
    }
  }
});

app.post('/category_input',(req,res) => {
  let responseObject = req.body;
  let entered_digit = responseObject.dtmf.digits;
  if(entered_digit == ''){
    res.json([
      getTalkAction("you didn't enter any digit"),
      getTalkAction(categoryOptionsText),
      categoryInput
    ]);
  }
  else{
    if(categoryOptions.hasOwnProperty(entered_digit)){
      let categoryName = categoryOptions[entered_digit];
      getStoryOptions(categoryName).then(
        function(value){
          console.log(value);
          console.log(storyOptionsText);
          res.json([
            getTalkAction(storyOptionsText),
            storyInput
          ]);
        },
        function(err){
          console.log(err);
        }
      );
    }
    else{
      res.json([
        getTalkAction("sorry, you have chosen invalid option."),
        getTalkAction(categoryOptionsText),
        categoryInput
      ]);
    }
  }
});

app.listen(process.env.PORT, () => console.log(`Running on port ${process.env.PORT}`));
