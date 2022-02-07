require('dotenv').config();
const path = require('path')
const {v4 : uuidv4} = require('uuid');
const fs = require('fs');
// const https = require('follow-redirects').https;
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

function getTalkAction(textToTalk,to,needBargeIn=true){
  let speechRate = 'medium'
  if(userInfo.hasOwnProperty(to)){
    speechRate = userInfo[to]["speechRate"]
  }
  let talkAction = {
    "action": "talk",
    "text": "<speak><prosody rate='"+`${speechRate}`+"'>"+`${textToTalk}</prosody></speak>`,
    "bargeIn":needBargeIn,
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

async function getStoryOptions(to,category=undefined){
  let result = ""
  if(category){
    result = await client.query(`select * from story_book where category_id = 
    (select id from story_category where name=$1) OFFSET ${userInfo[to]["previousStoryNumber"]} ROWS FETCH FIRST 5 ROWS ONLY`,
    [category]
    )
  }
  else{
    result = await client.query(`select * from story_book OFFSET ${userInfo[to]["previousStoryNumber"]} ROWS FETCH FIRST 5 ROWS ONLY `);
  }
  userInfo[to]["previousStoryNumber"] += 4
  userInfo[to]["storyOptionsText"] = ""
  userInfo[to]["storyOptions"] = {}
  let rows = result.rows.slice(0,4)
  for(let i=0; i < rows.length; i++){
    let book = rows[i];
    userInfo[to]["storyOptionsText"] += "To select "+book.name+", press "+(i+1)+". ";
    userInfo[to]["storyOptions"][(i+1).toString()] = book.name;
  }
  if(result.rows.length > 4){
    userInfo[to]["storyOptionsText"] += "To list next top 4 Stories, press 5. "
  }
  userInfo[to]["storyOptionsText"] += "To repeat current menu, press 8. To go to previous menu, press 9."
  return "succesfully fetched the stories.";
}

async function getCategoryOptions(to){
  const result = await client.query(`select * from story_category OFFSET ${userInfo[to]["previousCategoryNumber"]} ROWS FETCH FIRST 5 ROWS ONLY`);
  userInfo[to]["previousCategoryNumber"] += 4
  userInfo[to]["categoryOptionsText"] = ""
  userInfo[to]["categoryOptions"] = {}
  let rows = result.rows.slice(0,4)
  for(let i=0; i < rows.length; i++){
    let category = rows[i];
    userInfo[to]["categoryOptionsText"] += "To select " + category.name + ", press "+(i+1)+". ";
    userInfo[to]["categoryOptions"][(i+1).toString()] = category.name;
  }
  if(result.rows.length > 4){
    userInfo[to]["categoryOptionsText"] += "To list next top 4 Categories, press 5. "
  }
  userInfo[to]["categoryOptionsText"] += "To repeat current menu, press 8. To go to previous menu, press 9."
  return "successfully fetched the categories.";
}

function storyCompleted(to){
  userInfo[to]["isAudioActive"] = false
  userInfo[to]["currentStory"] = undefined
  vonage.calls.update(userInfo[to]["uuid"], 
    {
      "action": "transfer",
      "destination": {
        "type": "ncco",
        "ncco": [
          getTalkAction("Your Story was completed. Thank you for listening.",to,false)
        ]
      }
    },(req, res) => {
    console.log("Disconnecting...")
  });
}

function startStream(to){
  userInfo[to]["isAudioActive"] = true;
  vonage.calls.stream.start(userInfo[to]["uuid"], { stream_url: [remoteUrl + `audio/${userInfo[to]["currentStoryAudioFileName"]}`], level: 1 }, (err, res) => {
    if(err) { console.error(err); }
    else {
        console.log(res);
        userInfo[to]["storyPlayingStartingTime"] = Date.now();
        const path = `${__dirname}/AudioFiles/${userInfo[to]["currentStoryAudioFileName"]}`;
        getAudioDurationInSeconds(path).then((duration) => {
          userInfo[to]["storyTimeOutId"] = setTimeout( () => { storyCompleted(to) },(duration+1).toFixed(0)*1000);
        });
    }
  });
}

function stopStream(to){
  clearTimeout(userInfo[to]["storyTimeOutId"]);
  userInfo[to]["isAudioActive"] = false;
  vonage.calls.stream.stop(userInfo[to]["uuid"], (err, res) => {
    if(err) { console.error(err); }
    else {
        console.log(res);
        let timeDifference = ((Date.now() - userInfo[to]["storyPlayingStartingTime"] - 1500)/1000).toFixed(0);
        const currentPath = `${__dirname}/AudioFiles/${userInfo[to]["currentStoryAudioFileName"]}`;

        getAudioDurationInSeconds(currentPath).then((duration) => {
          if(timeDifference >= duration){
            storyCompleted(to);
          }
          else{
            userInfo[to]["currentStoryAudioFileName"] = uuidv4() + ".mp3"
            const newPath = `${__dirname}/AudioFiles/${userInfo[to]["currentStoryAudioFileName"]}`;
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
  });
}

function callCompleted(to){
  clearTimeout(userInfo[to]["storyTimeOutId"]);
  userInfo[to]["isAudioActive"] = false;
  let timeDifference = ((Date.now() - userInfo[to]["storyPlayingStartingTime"] - 1500)/1000).toFixed(0);
  const currentPath = `${__dirname}/AudioFiles/${userInfo[to]["currentStoryAudioFileName"]}`;

  getAudioDurationInSeconds(currentPath).then((duration) => {
    if(timeDifference >= duration){
      storyCompleted(to);
    }
    else{
      userInfo[to]["currentStoryAudioFileName"] = uuidv4() + ".mp3"
      const newPath = `${__dirname}/AudioFiles/${userInfo[to]["currentStoryAudioFileName"]}`;
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

async function checkStoryExistency(to,requestedStoryName){
  const result = await client.query(`select * from story_book where name = $1`,[requestedStoryName]);
  if(result.rows.length > 0){
    userInfo[to]["currentStory"] = requestedStoryName
    userInfo[to]["currentStoryAudioFileName"] = "source.mp3" // result.rows[0].content_path
    return true
  }
  else{
    return false
  }
}

// Global Variables

let userInfo = {}
let conversationIdToMobileNumber = {}
let remoteUrl = "https://d297-2401-4900-16eb-47d9-9827-3ebe-a273-8256.ngrok.io/"
let mainMenuInputAction = getInputAction("main_menu_input")
let mainMenuOptions = "To List new Stories, press 2. To List Story Categories, press 3.\
                      To Request a new Story, press 4. To Repeat Current Menu, press 8.\
                      To exit from this menu, press 9. To increment speech Rate, press star.\
                      To decrement speech Rate, press ash."
let storyInput = getInputAction("story_input",false,2)
let categoryInput = getInputAction("category_input",false,2)
let requestStoryInput = getInputAction("request_story",true)
let storyReadingInput = getInputAction("story_reading")
let confirmRequestedStoryInput = getInputAction("confirm_request_story")
let speechRateIncrements = {
  "x-slow":"slow",
  "slow":"medium",
  "medium":"fast",
  "fast":"x-fast",
  "x-fast":"x-fast"
}
let speechRateDecrements = {
  "x-fast":"fast",
  "fast":"medium",
  "medium":"slow",
  "slow":"x-slow",
  "x-slow":"x-slow"
}

app.get('/call', (req, res) => {
  let ncco = []
  let to = req.query.to || process.env.TO_NUMBER
  if(userInfo.hasOwnProperty(to)){
    if(userInfo[to]["currentStory"]){
      ncco.push(getTalkAction("To continue reading "+userInfo[to]["currentStory"]+" Story, press 1.",to));
    }
  }
  else{
    ncco.push(getTalkAction("To start reading a new Story, press 1.",to))
  }
  ncco.push(getTalkAction(mainMenuOptions,to))
  ncco.push(mainMenuInputAction)
  vonage.calls.create({
    to: [{
      type: 'phone',
      number: req.query.to || process.env.TO_NUMBER
    }],
    from: {
      type: 'phone',
      number: process.env.VONAGE_NUMBER,
    },
    ncco: ncco
  }, (err, resp) => {
    if (err)
      console.error(err);
    if (resp)
      console.log(resp);
  });
  res.send('<h1>Call was made</h1>');
});

app.post('/event', (req, res) => {
  let body = req.body;
  console.log(body);
  let to = body.to;
  if(body.status == 'answered'){
    conversationIdToMobileNumber[body.conversation_uuid] = to;
    if(!userInfo.hasOwnProperty(to)){
      userInfo[to] = {}
      userInfo[to]["uuid"] = body.uuid
      userInfo[to]["storyOptionsText"] = ""
      userInfo[to]["categoryOptionsText"] = ""
      userInfo[to]["storyOptions"] = {}
      userInfo[to]["categoryOptions"] = {}
      userInfo[to]["currentStory"] = undefined
      userInfo[to]["isAudioActive"] = false
      userInfo[to]["currentStoryAudioFileName"] = undefined
      userInfo[to]["storyPlayingStartingTime"] = undefined
      userInfo[to]["storyTimeOutId"] = undefined
      userInfo[to]["previousStoryNumber"] = undefined
      userInfo[to]["previousCategoryNumber"] = undefined
      userInfo[to]["speechRate"] = "medium"
    }
    else{
      userInfo[to]["uuid"] = body.uuid
    }
  }
  if(req.body.status == 'completed'){
    if(userInfo[to]["isAudioActive"]){
      callCompleted(to);
    }
  }
  res.status(200).send('');
});

// Level 1

app.post('/main_menu_input',(req,res) => {
  let responseObject = req.body;
  console.log(responseObject);
  let entered_digit = responseObject.dtmf.digits;
  if(entered_digit == ''){
    let to = conversationIdToMobileNumber[responseObject.conversation_uuid]
    let ncco = []
    ncco.push(getTalkAction("you didn't enter any digit",to))
    if(userInfo[to]["currentStory"]){
      ncco.push(getTalkAction("To continue reading "+userInfo[to]["currentStory"]+" Story, press 1.",to));
    }
    else{
      ncco.push(getTalkAction("To start reading a new Story, press 1.",to));
    }
    ncco.push(getTalkAction(mainMenuOptions,to));
    ncco.push(mainMenuInputAction);
    res.json(ncco);
  }
  else{
    let to = responseObject.to;
    let ncco = []
    switch (entered_digit){
      case "1":
        if(!userInfo[to]["currentStory"]){
          userInfo[to]["currentStory"] = "new"
          userInfo[to]["currentStoryAudioFileName"] = "default.mp3"
        }
        startStream(to);
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
        userInfo[to]["previousStoryNumber"] = 0
        getStoryOptions(to).then(
          function(value){
            ncco.push(getTalkAction(userInfo[to]["storyOptionsText"],to))
            ncco.push(storyInput)
            res.json(ncco);
          },
          function(err){
            console.log(err);
          }
        );
        break;
      case "3":
        userInfo[to]["previousCategoryNumber"] = 0
        getCategoryOptions(to).then(
          function(value){
            ncco.push(getTalkAction(userInfo[to]["categoryOptionsText"],to))
            ncco.push(categoryInput)
            res.json(ncco);
          },
          function(err){
            console.log(err);
          }
        );
        break;
      case "4":
        res.json([
          getTalkAction("please speak out the story name, you want",to,false),
          requestStoryInput
      ]);
        break;
      case "8":
        if(userInfo[to]["currentStory"]){
          ncco.push(getTalkAction("To continue reading "+userInfo[to]["currentStory"]+" Story, press 1.",to));
        }
        else{
          ncco.push(getTalkAction("To start reading a new Story, press 1.",to));
        }
        ncco.push(getTalkAction(mainMenuOptions,to));
        ncco.push(mainMenuInputAction);
        res.json(ncco);
        break;
      case "9":
        res.json({
          action:"hangup"
        });
        break;
      case "*":
        userInfo[to]["speechRate"] = speechRateIncrements[userInfo[to]["speechRate"]];
        if(userInfo[to]["currentStory"]){
          ncco.push(getTalkAction("To continue reading "+userInfo[to]["currentStory"]+" Story, press 1.",to));
        }
        else{
          ncco.push(getTalkAction("To start reading a new Story, press 1.",to));
        }
        ncco.push(getTalkAction(mainMenuOptions,to));
        ncco.push(mainMenuInputAction);
        res.json(ncco);
        break;
      case "#":
        userInfo[to]["speechRate"] = speechRateDecrements[userInfo[to]["speechRate"]];
        if(userInfo[to]["currentStory"]){
          ncco.push(getTalkAction("To continue reading "+userInfo[to]["currentStory"]+" Story, press 1.",to));
        }
        else{
          ncco.push(getTalkAction("To start reading a new Story, press 1.",to));
        }
        ncco.push(getTalkAction(mainMenuOptions,to));
        ncco.push(mainMenuInputAction);
        res.json(ncco);
        break;
      default:
        ncco.push(getTalkAction("sorry, you have chosen an invalid option",to))
        if(userInfo[to]["currentStory"]){
          ncco.push(getTalkAction("To continue reading "+userInfo[to]["currentStory"]+" Story, press 1.",to));
        }
        else{
          ncco.push(getTalkAction("To start reading a new Story, press 1.",to));
        }
        ncco.push(getTalkAction(mainMenuOptions,to));
        ncco.push(mainMenuInputAction);
        res.json(ncco);
    }
  }
});

// Level 2

app.post('/story_input',(req,res) => {
  let responseObject = req.body;
  let entered_digit = responseObject.dtmf.digits;
  if(entered_digit == ''){
    let to = conversationIdToMobileNumber[responseObject.conversation_uuid]
    res.json([
      getTalkAction("Sorry, You have not chosen any option.",to),
      getTalkAction(userInfo[to]["storyOptionsText"],to),
      storyInput
    ]);
  }
  else{
    let to = responseObject.to;
    let ncco = []
    switch(entered_digit){
      case "1":
      case "2":
      case "3":
      case "4":
        if(userInfo[to]["storyOptions"][entered_digit] == undefined){
          res.json([
            getTalkAction("sorry, you have chosen invalid option.",to),
            getTalkAction(userInfo[to]["storyOptionsText"],to),
            storyInput
          ]);
        }
        else{
          userInfo[to]["currentStory"] = userInfo[to]["storyOptions"][entered_digit];
          userInfo[to]["currentStoryAudioFileName"] = "source.mp3"
          startStream(to);
          res.json([
            getTalkAction("Please wait for 2 to 3 minutes, your story is being downloaded",to,false),
            {
              "action":"stream",
              "streamUrl": ["https://github.com/manikanta-MB/IVR-Audio-Recordings/blob/main/silence.mp3?raw=true"],
              "loop":0,
              "bargeIn":true
            },
            storyReadingInput
          ]);
        }
        break;
      case "5":
        if(userInfo[to]["storyOptionsText"].includes("press 5.")){
          getStoryOptions(to).then(
            function(value){
              ncco.push(getTalkAction(userInfo[to]["storyOptionsText"],to))
              ncco.push(storyInput)
              res.json(ncco);
            },
            function(err){
              console.log(err);
            }
          );
        }
        else{
          res.json([
            getTalkAction("sorry, you have chosen invalid option.",to),
            getTalkAction(userInfo[to]["storyOptionsText"],to),
            storyInput
          ]);
        }
        break;
      case "8":
        res.json([
          getTalkAction(userInfo[to]["storyOptionsText"],to),
          storyInput
        ]);
        break;
      case "9":
        if(userInfo[to]["currentStory"]){
          ncco.push(getTalkAction("To continue reading "+userInfo[to]["currentStory"]+" Story, press 1.",to));
        }
        else{
          ncco.push(getTalkAction("To start reading a new Story, press 1.",to));
        }
        ncco.push(getTalkAction(mainMenuOptions,to));
        ncco.push(mainMenuInputAction);
        res.json(ncco);
        break;
      default:
        res.json([
          getTalkAction("sorry, you have chosen invalid option.",to),
          getTalkAction(userInfo[to]["storyOptionsText"],to),
          storyInput
        ]);
        break;
    }
  }
});

app.post("/story_reading",(req,res) => {
  let responseObject = req.body;
  let entered_digit = responseObject.dtmf.digits;

  if(entered_digit == ''){
    let to = conversationIdToMobileNumber[responseObject.conversation_uuid]
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
    let to = responseObject.to;
    let ncco = []
    switch(entered_digit){
      case "1":
        if(userInfo[to]["isAudioActive"]){
          stopStream(to);
        }
        else{
          startStream(to);
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
        if(userInfo[to]["isAudioActive"]){
          stopStream(to);
        }
        setTimeout(() => {
          if(userInfo[to]["currentStory"]){
            ncco.push(getTalkAction("To continue reading Current Story, press 1.",to));
          }
          else{
            ncco.push(getTalkAction("To start reading a new Story, press 1.",to));
          }
          ncco.push(getTalkAction(mainMenuOptions,to));
          ncco.push(mainMenuInputAction);
          res.json(ncco);
        },2000);
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
    let to = conversationIdToMobileNumber[responseObject.conversation_uuid]
    res.json([
      getTalkAction("Sorry, you have not chosen any option.",to),
      getTalkAction(userInfo[to]["categoryOptionsText"],to),
      categoryInput
    ]);
  }
  else{
    let to = responseObject.to;
    let ncco = []
    switch(entered_digit){
      case "1":
      case "2":
      case "3":
      case "4":
        let categoryName = userInfo[to]["categoryOptions"][entered_digit];
        if(categoryName == undefined){
          res.json([
            getTalkAction("sorry, you have chosen invalid option.",to),
            getTalkAction(userInfo[to]["categoryOptionsText"],to),
            categoryInput
          ]);
        }
        else{
          userInfo[to]["previousStoryNumber"] = 0
          getStoryOptions(to,categoryName).then(
            function(value){
              ncco.push(getTalkAction(userInfo[to]["storyOptionsText"],to))
              ncco.push(storyInput)
              res.json(ncco);
            },
            function(err){
              console.log(err);
            }
          );
        }
        break;
      case "5":
        if(userInfo[to]["categoryOptionsText"].includes("press 5.")){
          getCategoryOptions(to).then(
            function(value){
              ncco.push(getTalkAction(userInfo[to]["categoryOptionsText"],to))
              ncco.push(categoryInput)
              res.json(ncco);
            },
            function(err){
              console.log(err);
            }
          );
        }
        else{
          res.json([
            getTalkAction("sorry, you have chosen invalid option.",to),
            getTalkAction(userInfo[to]["categoryOptionsText"],to),
            categoryInput
          ]);
        }
        break;
      case "8":
        res.json([
          getTalkAction(userInfo[to]["categoryOptionsText"],to),
          categoryInput
        ]);
        break;
      case "9":
        if(userInfo[to]["currentStory"]){
          ncco.push(getTalkAction("To continue reading "+userInfo[to]["currentStory"]+" Story, press 1.",to));
        }
        else{
          ncco.push(getTalkAction("To start reading a new Story, press 1.",to));
        }
        ncco.push(getTalkAction(mainMenuOptions,to));
        ncco.push(mainMenuInputAction);
        res.json(ncco);
        break;
      default:
        res.json([
          getTalkAction("sorry, you have chosen invalid option.",to),
          getTalkAction(userInfo[to]["categoryOptionsText"],to),
          categoryInput
        ]);
        break;
    }
  }
});

app.post("/request_story", (req,res) => {
  let requestObj = req.body;
  if(requestObj.speech.timeout_reason == 'start_timeout'){
    let to = conversationIdToMobileNumber[responseObject.conversation_uuid]
    res.json([
      getTalkAction("Sorry, you have not spoken anything.",to,false),
      getTalkAction("please speak out the story name, you want",to,false),
      requestStoryInput
    ]);
  }
  else if(requestObj.speech.hasOwnProperty("error") || !requestObj.speech.results || (requestObj.speech.results.length == 0)){
    let to = conversationIdToMobileNumber[responseObject.conversation_uuid]
    res.json([
      getTalkAction("Sorry, we are not able to analyze your voice, please speak out again.",to,false),
      requestStoryInput
    ]);
  }
  else{
    let spokenData = requestObj.speech.results[0].text
    console.log("requested Story Name ",spokenData);
    let to = requestObj.to
    checkStoryExistency(to,spokenData).then(function(isStoryExist){
      if(isStoryExist){
        startStream(to);
        res.json([
          getTalkAction("Please wait for 2 to 3 minutes, your story is being loaded",to,false),
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
        res.json([
          getTalkAction("Your requested Story was not available right now. we will make it available for you later. Please request any other Story.",to,false),
          requestStoryInput
        ]);
      }
    },
    function(err){
      console.log(err);
    });
  }
});

app.post("/confirm_request_story", (req,res) => {
  let responseObject = req.body;
  let entered_digit = responseObject.dtmf.digits;
  if(entered_digit == ''){
    let to = conversationIdToMobileNumber[responseObject.conversation_uuid]
    res.json([
      getTalkAction("Sorry, you have not chosen any option.",to,false),
      getTalkAction("To save, press 1. To cancel, press 2",to),
      confirmRequestedStoryInput
    ]);
  }
  else{
    let to = responseObject.to;
    switch(entered_digit){
      case "1":
        res.json([
          getTalkAction("Thank you. your requested story was saved.",to,false)
        ]);
        break;
      case "2":
        res.json([
          getTalkAction("Thank you. your requested story was not saved.",to,false)
        ]);
        break;
      default:
        res.json([
          getTalkAction("Sorry, you have chosen an invalid option.",to,false),
          getTalkAction("To save, press 1. To cancel, press 2",to),
          confirmRequestedStoryInput
        ]);
        break;
    }
  }
});

app.listen(process.env.PORT, () => console.log(`Running on port ${process.env.PORT}`));
