'use strict';

const Redis = require('node-redis');

const host_poll_interval = 60000;

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

var hosts_key_array = db_keys_hosts.split(";");

var hosts = [];

function FetchHostStatusStart(host_db_key,idx) {
   var link = Redis.createClient(6379, "redis");
   link.get(host_db_key, function(error,value) {
     if(!error) {
       if(!hosts[idx] || (hosts[idx] != value)) {
         console.log("Host ("+host_db_key+") presence change detected via polling");
         ScheduleTick();
       }
       hosts[idx] = value;
     }
   });
   link.quit();
}

function FetchHostsStatusStart() {
  for(var i=0;i<hosts_key_array.length;i++)
    FetchHostStatusStart(hosts_key_array[i],i);
}

setInterval(FetchHostsStatusStart,host_poll_interval);


function TrackHost(host_db_key) {
   
}
