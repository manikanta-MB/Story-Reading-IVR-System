const { Client } = require("pg");

const client = new Client({
    host: "localhost",
    port: 5432,
    user: "postgres",
    password: "postgres",
    database: "ivr_project"
});

client.on("connect", () => {
    console.log("Database connected.");
});

client.on("end", () => {
    console.log("Database Disconnected.");
});

client.connect();

module.exports = client;


// client.query(`select exists(select * from story_book where name = $1)`,["Steve Jobs"],(err,result) => {
//     if(err){
//       console.log(err);
//     }
//     else{
//       console.log(result.rows[0].exists);
//     }
//     client.end();
// });

// client.on("on")