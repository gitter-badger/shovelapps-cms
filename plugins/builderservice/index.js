var io = require('socket.io');
var ioclient = require('socket.io-client');
var ss = require('socket.io-stream');
var fs = require("fs");
var path = require("path");
var jade = require("jade");
var packager = require("../../lib/packager");
var frontend = require("../../lib/frontend");
var config = require("config").get("app");
var debug = require("debug")("cms:builderservice");
var builds = require("../../lib/db").builds;
module.exports = builder;


function builder(app, server, sockets) {
  var status = "";

  app.locals.googlemaps = {}
  app.get('/admin/build', function(req, res, next) {
    builds.find({}).limit(9).exec(function(err, docs) {
      if (err) {
        return res.send(500, "I errored");
      }
      docs.forEach(function(doc) {
        var d = new Date(doc.timestamp);
        doc.date = d.toDateString();
        doc.buildIdShort = doc.buildId.split('-')[0];

      });
      debug(docs);
      app.locals.builds = docs;
      res.send(jade.renderFile(__dirname + "/build.jade", app.locals));
    });
  });

  builder.sockets = sockets;

  sockets.platform.on('apkbuilt', function(data) {
    debug('Platform emitted apkbuilt');
    debug(arguments);
    app.emit('apkbuilt', data);
  });

  sockets.platform.on('datareceived', function(data) {
    debug("Platform emitted datareceived");
    debug(data);
    app.emit('source code upload progress', data);
    if (data.progress == "100%") {
      debug('source code upload complete');
      app.emit('upload-complete', data);
    }
  });

  app.on("apkbuilt", function(data) {
    debug('apkbuilt');
    debug(data);
    var buildData = data.url.split('/');
    var buildId = buildData[buildData.length - 1].split('.')[0];
    builds.update({
      buildId: buildId
    }, {
      $set: {
        buildId: buildId,
        apkUrl: data.url,
        built: 1,
        timestamp: Date.now()
      }
    });
  });
  app.on("upload-complete", function(data) {
    builds.insert({
      buildId: data.buildId.buildId,
      apkUrl: '',
      built: 0,
      timestamp: Date.now()
    });
  });
  sockets.adminPanel.on("connection", function(adminpanelSocket) {
    adminpanelSocket.on("already working?", function() {
      if (status == "") {
        adminpanelSocket.emit('doin nothing');
      } else if (status != 'source code upload progress') {
        adminpanelSocket.emit(status);
      }
      debug('checking builder status: ' + status);
    });
    adminpanelSocket.on("buildApk", function(options) {
      builder.renderAndRequestBuild(app, adminpanelSocket);
      status = 1;
    });
    app.on("source code upload progress", function(data) {
      adminpanelSocket.emit("source code upload progress", data);
      status = "source code upload progress";
    });
    app.on("apkbuilt", function(data) {
      adminpanelSocket.emit("apkbuilt", data);
      status = "";
    });
    app.on("upload-complete", function(data) {
      debug("upload-complete", data);
      adminpanelSocket.emit("upload-complete", data);
      status = "upload-complete";
    });
    // Tell the CMS frontend that we are connected
    // to the build platform by emitting.
    // If we are already connected on init
    if (!sockets.platform.disconnected) {
      adminpanelSocket.emit("platform connect");
    }
    // Or if the connection takes place later
    sockets.platform.on("connect", function platformSocketError(err) {
      adminpanelSocket.emit("platform connect");
    });
  });
}

builder.renderAndRequestBuild = function(app, clientSocket) {
  frontend.renderFrontend(app, {}, function(err, html) {
    if (err) {
      clientSocket.emit("error rendering frontend");
      debug("rendering failed on builder %s", err.stack);
      return;
    }
    var zipStream = packager.createAppZipStream(html);
    //temporary file for getting the stream size
    var filename = path.join(process.cwd(), "filestorage", "tmp", "app.zip");
    var fs = require("fs");
    var tmpFileStream = fs.createWriteStream(filename);
    zipStream.on("error", function(err) {
      debug("Error creating app zip stream");
      debug(err);
    });
    // From archiver docs.
    //   The end, close or finish events on the destination stream 
    //    may fire right after calling this method so you should 
    //   set listeners beforehand to properly detect stream completion. 
    // BUT!!! The finish event on archive is unreliable. it fires when
    // finalize() is called.
    zipStream.once("end", function() {
      debug(fs.statSync(filename).size);
      tmpFileStream.end(undefined, undefined, function() {
        zipStream.unpipe(tmpFileStream);
        debug("finished zipping");
        clientSocket.emit("finished zipping");
        var readStream = fs.createReadStream(filename, {
          autoClose: true
        });
        var buildStream = builder.createBuildRequestStream(app, {
          appName: config.appName,
          size: fs.statSync(filename).size
        });
        debug(fs.statSync(filename).size);
        buildStream.on("error", function(err) {
          debug("Error building app.");
          debug(err);
        });
        readStream.pipe(buildStream);
      });
    });
    zipStream.pipe(tmpFileStream);
  });
}

builder.createBuildRequestStream = function(app, appOptions) {
  var sockets = builder.sockets,
    stream = ss.createStream();
  ss(sockets.platform).emit('sourcecodeupload', stream, appOptions);
  return stream;
}