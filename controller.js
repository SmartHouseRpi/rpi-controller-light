'use strict';

const Redis = require('redis');
var XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;

const poll_interval = 120000;

var db_key_daytime = undefined;
var db_keys_hosts = undefined;

if(typeof process.env.db_keys_hosts !== 'undefined') {
  db_keys_hosts = process.env.db_keys_hosts;
} else {
  throw "'db_keys_hosts' environmental variable is not set. Set it and restart container";
}

if(typeof process.env.db_key_daytime !== 'undefined') {
  db_key_daytime = process.env.db_key_daytime;
} else {
  throw "'db_key_daytime' environmental variable is not set. Set it and restart container";
}

var redis = Redis.createClient(6379, "redis");
var redis_sub = redis.duplicate(); //connection for "subscriber" mode

redis.on("error", function (err) {
    console.warn("Redis reg channel error :" + err);
});

redis_sub.on("error", function (err) {
    console.warn("Redis subscriber channel error :" + err);
});

//Initializing data structures

var hosts = [];
var daytime = "unknown";

var subscription_back_map = [];
var host_groups_array = db_keys_hosts.split("|");
var hosts_key_array = [];
for(var i=0;i<host_groups_array.length;i++) {
 hosts_key_array.push(host_groups_array[i].split(";")); 
 hosts.push([]);
 for(var j=0;j<hosts_key_array[i].length;j++) {
   subscription_back_map[hosts_key_array[i][j]]= [i,j];
 }
}

//Save updates section

function setDaytime(new_daytime) {
  if(daytime != new_daytime) {
    daytime = new_daytime;
    console.log("Daytime changed to "+daytime);
    ScheduleTick();
  }
}

function setHostState(groupIdx,hostIdx,state) {
  if(!hosts[groupIdx][hostIdx] || (hosts[groupIdx][hostIdx] != state)) {
    hosts[groupIdx][hostIdx] = state;
    console.log("Host #"+(hostIdx+1)+" ("+hosts_key_array[groupIdx][hostIdx]+") of group #"+(groupIdx+1)+" presence changed to \""+state+"\"");
    ScheduleTick();
  }
}

//Polling section

function createFetchStatusCallback(grpIdx,hostIdx) {
  return function(error,value) {
    if(!error)
      setHostState(grpIdx,hostIdx,value);
    else
      console.warn("Host state polling failed: "+error);
  }
}

function InitiatePoll() {
  redis.get(db_key_daytime,function(error,value) {
    if(!error)
      setDaytime(value);
    else
      console.warn("Daytime polling failed: "+error);
  });

  for(var i=0;i<hosts_key_array.length;i++) {
    for(var j=0;j<hosts_key_array[i].length;j++)
     redis.get(hosts_key_array[i][j], createFetchStatusCallback(i,j));
  }
}

setInterval(InitiatePoll,poll_interval);
InitiatePoll(); //initial fetch of all values

//Subscriptions

redis_sub.on("message",function(channel,message) {
  console.log("Notification on channel \""+channel+"\": "+message);
  if(channel.indexOf(".subscription") != (channel.length-13)) {
    console.warn("channel does not end with \".subscription\". discarding");	  
    return;
  }
  channel = channel.substring(0,channel.length-13);
  if(channel == db_key_daytime)
    setDaytime(message);
  else {
    var idx = subscription_back_map[channel];
    if(idx == -1)
      console.warn("Notification on unexpected channel "+channel);
    else
      setHostState(idx[0],idx[1],message);
  }
});

redis_sub.on("subscribe",function(channel,count) {
  console.log("Subscribed to channel \""+channel+"\"");
});

redis_sub.subscribe(db_key_daytime+".subscription");
for(var i=0;i<hosts_key_array.length;i++) {
  for(var j=0;j<hosts_key_array[i].length;j++)
    redis_sub.subscribe(hosts_key_array[i][j]+".subscription");
}

//State machine

var tickScheduled = false;
function ScheduleTick() {
  if(!tickScheduled) {
    setTimeout(Tick,0);
    tickScheduled = true;
  }    
}

var State = {
  ONLINE_NIGHT: 0,
  ONLINE_DAY: 1,
  OFFLINE_NIGHT: 2,
  OFFLINE_DAY: 3,
  INITIAL: -1
}

var state = State.INITIAL;

var rules = [];

function presence() {
  return (hosts.length>0)&&(hosts.every(group => group.some(host => host=="online")));
}

rules.push({
  from: State.ONLINE_NIGHT,
  to: State.ONLINE_DAY,
  condition: () => (daytime!="night")
});

rules.push({
  from: State.ONLINE_DAY,
  to: State.ONLINE_NIGHT,
  condition: () => (daytime=="night")
});

rules.push({
  from: State.ONLINE_NIGHT,
  to: State.OFFLINE_NIGHT,
  condition: () => (!presence())
});

rules.push({
  from: State.OFFLINE_NIGHT,
  to: State.ONLINE_NIGHT,
  condition: () => presence()
});

rules.push({
  from: State.OFFLINE_NIGHT,
  to: State.OFFLINE_DAY,
  condition: () => (daytime!="night")
});

rules.push({
  from: State.OFFLINE_DAY,
  to: State.OFFLINE_NIGHT,
  condition: () => (daytime=="night")
});

rules.push({
  from: State.ONLINE_DAY,
  to: State.OFFLINE_DAY,
  condition: () => (!presence())
});

rules.push({
  from: State.OFFLINE_DAY,
  to: State.ONLINE_DAY,
  condition: () => (presence())
});

rules.push({
  from: State.INITIAL,
  to: State.OFFLINE_DAY,
  condition: () => (true)
});

function Tick() {
  tickScheduled = false;
  for(var i=0; i< rules.length; i++) {
    var rule = rules[i];
    if((state == rule.from) && (rule.condition())) {
      console.log("Transitioning from state "+ state +" to "+ rule.to);
      state = rule.to;
      ScheduleTick();
      return;
    }
  }
  console.log("Retaining in state "+state);
  applySideEffects(state);
};

function applySideEffects(state) {
  switch(state) {
    case State.OFFLINE_NIGHT:
    case State.OFFLINE_DAY:
    case State.ONLINE_DAY:
      closeRelay();
      break;
    case State.ONLINE_NIGHT:
      openRelay();
      break;
  }
}

var relayState = "unknown";

function closeRelay() {
  if(relayState != "closed") {
    console.log("closing relay");
    var xmlHttp = new XMLHttpRequest();
    var mimeType = "text/plain"
    xmlHttp.open('DELETE', 'http://relay/', true);  // true : asynchrone false: synchrone
    xmlHttp.setRequestHeader('Content-Type', mimeType);
    xmlHttp.send(null);
    console.log("closed");
    relayState = "closed";
  }   
}

function openRelay() {
  if(relayState != "opened") {
    console.log("openning relay");
    var xmlHttp = new XMLHttpRequest();
    var mimeType = "text/plain"
    xmlHttp.open('PUT', 'http://relay/', true);  // true : asynchrone false: synchrone
    xmlHttp.setRequestHeader('Content-Type', mimeType);
    xmlHttp.send(null);
    console.log("opened");
  relayState = "opened";
  }   
}
