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

function getTalkAction(textToTalk,needBargeIn=true){
  let talkAction = {
    "action": "talk",
    "text": textToTalk,
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
    (select id from story_category where name=$1)`,
    [category]
    )
  }
  else{
    result = await client.query(`select * from story_book`);
  }
  userInfo[to]["storyOptionsText"] = ""
  userInfo[to]["storyOptions"] = {}
  for(let i=0; i < result.rows.length; i++){
    let book = result.rows[i];
    userInfo[to]["storyOptionsText"] += "To select "+book.name+", press "+(i+1)+". ";
    userInfo[to]["storyOptions"][(i+1).toString()] = book.name;
  }
  return "successfully fetched the stories";
}

async function getCategoryOptions(to){
  const result = await client.query(`select * from story_category`);
  userInfo[to]["categoryOptionsText"] = ""
  userInfo[to]["categoryOptions"] = {}
  for(let i=0; i < result.rows.length; i++){
    let category = result.rows[i];
    userInfo[to]["categoryOptionsText"] += "To select " + category.name + ", press "+(i+1)+". ";
    userInfo[to]["categoryOptions"][(i+1).toString()] = category.name;
  }
  return "successfully fetched the categories";
}

function storyCompleted(to){
  userInfo[to]["isAudioActive"] = false
  userInfo[to]["currentStory"] = undefined
  fs.unlink(`${__dirname}/AudioFiles/${userInfo[to]["currentStoryAudioFileName"]}`,function(err){
    if(err){
      console.log(err);
    }
    console.log("File Deleted.");
  });
  vonage.calls.update(userInfo[to]["uuid"], 
    {
      "action": "transfer",
      "destination": {
        "type": "ncco",
        "ncco": [
          {
            "action": "talk",
            "text": "Your Story was completed. Thank you for listening.",
            "language": "en-IN",
            "level": 1
          }
        ]
      }
    },(req, res) => {
    console.log("Disconnecting...")
  });
}

function startStream(to){
  userInfo[to]["isAudioActive"] = true;
  if(userInfo[to]["isNewStoryRequest"]){
    let url = "https://github.com/manikanta-MB/IVR-Audio-Recordings/blob/main/NSC_.mp3?raw=true"
    userInfo[to]["currentStoryAudioFileName"] = uuidv4() + ".mp3"
    https.get(url,(res) => {
    	const path = `${__dirname}/AudioFiles/${userInfo[to]["currentStoryAudioFileName"]}`;
    	const filePath = fs.createWriteStream(path);
    	res.pipe(filePath);
    	filePath.on('finish',() => {
    		filePath.close();
    		console.log('Download Completed.');

        vonage.calls.stream.start(userInfo[to]["uuid"], { stream_url: [remoteUrl + `audio/${userInfo[to]["currentStoryAudioFileName"]}`], level: 1 }, (err, res) => {
          if(err) { console.error(err); }
          else {
              console.log(res);
              userInfo[to]["storyPlayingStartingTime"] = Date.now();
              getAudioDurationInSeconds(path).then((duration) => {
                  userInfo[to]["storyTimeOutId"] = setTimeout(() => { storyCompleted(to) },(duration+1).toFixed(0)*1000);
              });
          }
        });

    	})
    });
  }
  else{
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
            fs.unlink(currentPath,function(err){
              if(err){
                console.log(err);
              }
              console.log("File deleted.");
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
      fs.unlink(currentPath,function(err){
        if(err){
          console.log(err);
        }
        console.log("File deleted.");
      });
      console.log("cut completed.");
    }
  });
}

function isThereAnyRunningStory(to){
  if(userInfo[to]["currentStory"]){
    const filePath = `${__dirname}/AudioFiles/${userInfo[to]["currentStoryAudioFileName"]}`;
    fs.unlink(filePath,function(err){
      if(err){
        console.log(err);
      }
      console.log("Previous Story File Deleted.");
    });
  }
}

// Global Variables

let userInfo = {}
let remoteUrl = "https://64ff-36-255-87-144.ngrok.io/"
let mainMenuInputAction = getInputAction("main_menu_input")
let mainMenuOptions = "To List new Stories, press 2. To List Story Categories, press 3.\
                      To Request a new Story, press 4. To Repeat Current Menu, press 8.\
                      To exit from this menu, press 9."
let storyInput = getInputAction("story_input",false,2)
let categoryInput = getInputAction("category_input",false,2)
let requestStoryInput = getInputAction("request_story",true)
let storyReadingInput = getInputAction("story_reading")
let confirmRequestedStoryInput = getInputAction("confirm_request_story")

app.get('/call', (req, res) => {
  let ncco = []
  let to = req.query.to || process.env.TO_NUMBER
  if(userInfo.hasOwnProperty(to)){
    if(userInfo[to]["currentStory"]){
      ncco.push(getTalkAction("To continue reading Current Story, press 1."));
    }
  }
  ncco.push(getTalkAction(mainMenuOptions))
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
    if(!userInfo.hasOwnProperty(to)){
      userInfo[to] = {}
      userInfo[to]["uuid"] = body.uuid
      userInfo[to]["storyOptionsText"] = ""
      userInfo[to]["categoryOptionsText"] = ""
      userInfo[to]["storyOptions"] = {}
      userInfo[to]["categoryOptions"] = {}
      userInfo[to]["currentStory"] = undefined
      userInfo[to]["isAudioActive"] = false
      userInfo[to]["isNewStoryRequest"] = true
      userInfo[to]["currentStoryAudioFileName"] = undefined
      userInfo[to]["storyPlayingStartingTime"] = undefined
      userInfo[to]["storyTimeOutId"] = undefined
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
  let entered_digit = responseObject.dtmf.digits;
  let to = responseObject.to;
  if(entered_digit == ''){
    let ncco = []
    ncco.push(getTalkAction("you didn't enter any digit"))
    if(userInfo[to]["currentStory"]){
      ncco.push(getTalkAction("To continue reading Current Story, press 1."));
    }
    ncco.push(getTalkAction(mainMenuOptions));
    ncco.push(mainMenuInputAction);
    res.json(ncco);
  }
  else{
    let ncco = []
    switch (entered_digit){
      case "1":
        if(!userInfo[to]["currentStory"]){
          res.json([
            getTalkAction("sorry, you have chosen an invalid option"),
            getTalkAction(mainMenuOptions),
            mainMenuInputAction
          ])
        }
        else {
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
        }
        break;
      case "2":
        getStoryOptions(to).then(
          function(value){
            res.json([
              getTalkAction(userInfo[to]["storyOptionsText"]),
              storyInput
            ]);
          },
          function(err){
            console.log(err);
          }
        );
        break;
      case "3":
        getCategoryOptions(to).then(
          function(value){
            res.json([
              getTalkAction(userInfo[to]["categoryOptionsText"]),
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
          getTalkAction("please speak out the story name, you want",false),
          requestStoryInput
      ]);
        break;
      case "8":
        if(userInfo[to]["currentStory"]){
          ncco.push(getTalkAction("To continue reading Current Story, press 1."));
        }
        ncco.push(getTalkAction(mainMenuOptions));
        ncco.push(mainMenuInputAction);
        res.json(ncco);
        break;
      case "9":
        res.json({
          action:"hangup"
        });
        break;
      default:
        ncco.push(getTalkAction("sorry, you have chosen an invalid option"))
        if(userInfo[to]["currentStory"]){
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
  let entered_digit = responseObject.dtmf.digits;
  let to = responseObject.to;

  if(entered_digit == ''){
    res.json([
      getTalkAction("Sorry, You have not chosen any option."),
      getTalkAction(userInfo[to]["storyOptionsText"]),
      storyInput
    ]);
  }
  else{
    if(userInfo[to]["storyOptions"].hasOwnProperty(entered_digit)){
      isThereAnyRunningStory(to);
      userInfo[to]["currentStory"] = userInfo[to]["storyOptions"][entered_digit];
      userInfo[to]["isNewStoryRequest"] = true;
      startStream(to);
      userInfo[to]["isNewStoryRequest"] = false;
      res.json([
        getTalkAction("Please wait, your story is being downloaded",false),
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
        getTalkAction("sorry, you have chosen invalid option."),
        getTalkAction(userInfo[to]["storyOptionsText"]),
        storyInput
      ])
    }
  }
});

app.post("/story_reading",(req,res) => {
  let responseObject = req.body;
  let entered_digit = responseObject.dtmf.digits;
  let to = responseObject.to;

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
          let ncco = []
          if(userInfo[to]["currentStory"]){
            ncco.push(getTalkAction("To continue reading Current Story, press 1."));
          }
          ncco.push(getTalkAction(mainMenuOptions));
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
  let to = responseObject.to;

  if(entered_digit == ''){
    res.json([
      getTalkAction("Sorry, you have not chosen any option."),
      getTalkAction(userInfo[to]["categoryOptionsText"]),
      categoryInput
    ]);
  }
  else{
    if(userInfo[to]["categoryOptions"].hasOwnProperty(entered_digit)){
      let categoryName = userInfo[to]["categoryOptions"][entered_digit];
      getStoryOptions(to,categoryName).then(
        function(value){
          res.json([
            getTalkAction(userInfo[to]["storyOptionsText"]),
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
        getTalkAction(userInfo[to]["categoryOptionsText"]),
        categoryInput
      ]);
    }
  }
});

app.post("/request_story", (req,res) => {
  let requestObj = req.body;
  if(requestObj.speech.timeout_reason == 'start_timeout'){
    res.json([
      getTalkAction("Sorry, you have not spoken anything.",false),
      getTalkAction("please speak out the story name, you want",false),
      requestStoryInput
    ]);
  }
  else if(requestObj.speech.hasOwnProperty("error") || !requestObj.speech.results || (requestObj.speech.results.length == 0)){
    res.json([
      getTalkAction("Sorry, we are not able to analyze your voice, please speak out again.",false),
      requestStoryInput
    ]);
  }
  else{
    let spokenData = requestObj.speech.results[0].text
    res.json([
      getTalkAction("your requested story is "+spokenData,false),
      getTalkAction("To save, press 1. To cancel, press 2"),
      confirmRequestedStoryInput
    ])
  }
});

app.post("/confirm_request_story", (req,res) => {
  let responseObject = req.body;
  let entered_digit = responseObject.dtmf.digits;
  if(entered_digit == ''){
    res.json([
      getTalkAction("Sorry, you have not chosen any option.",false),
      getTalkAction("To save, press 1. To cancel, press 2"),
      confirmRequestedStoryInput
    ]);
  }
  else{
    switch(entered_digit){
      case "1":
        res.json([
          getTalkAction("Thank you. your requested story was saved.",false)
        ]);
        break;
      case "2":
        res.json([
          getTalkAction("Thank you. your requested story was not saved.",false)
        ]);
        break;
      default:
        res.json([
          getTalkAction("Sorry, you have chosen an invalid option.",false),
          getTalkAction("To save, press 1. To cancel, press 2"),
          confirmRequestedStoryInput
        ]);
        break;
    }
  }
});

app.listen(process.env.PORT, () => console.log(`Running on port ${process.env.PORT}`));
