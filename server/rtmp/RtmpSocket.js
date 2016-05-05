/*
 * @File:   Category.js
 * @Author: yintaibing, SCUT Software Engineering, Grade 2012, Class 6.
 * @Date:   2016/05/02
 * @Remark: This file refers to: 
 *          https://github.com/illuspas/Node-Media-Server/blob/master/nm_rtmp_conn.js
 */

var QueueBuffer = require('./QueueBuffer.js');
var AMF = require('./RtmpAmf.js');
var RtmpHandshake = require('./RtmpHandshake.js');
var User = require('../bean/User.js');
var myutil = require('../myutil/myutil.js');

var aac_sample_rates = [
    96000, 88200, 64000, 48000,
    44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000,
    7350, 0, 0, 0
];

var ReadUInt24BE = function(buf, offset) {
    if (offset == null) {
        offset = 0;
    }
    return (buf[0 + offset] << 16) + (buf[1 + offset] << 8) + buf[2 + offset];
};

var WriteUInt24BE = function(buf, value, offset) {
    if (offset == null) {
        offset = 0;
    }
    buf[offset] = (value >> 16) & 0xFF;
    buf[offset + 1] = (value >> 8) & 0xFF;
    buf[offset + 2] = value & 0xFF;
};

function RtmpSocket(streamId, socket, userManager, roomManager) {
	this.streamId = streamId;
	this.socket = socket;
	this.um = userManager;
	this.user = null;
	this.rm = roomManager;
	this.rh = null;
	this.isPublisherStream = false;

	this.qb = new QueueBuffer();
	this.sendBufferQueue = [];

	this.rtmpStatus = 0;
    this.isStarting = false;
    this.inChunkSize = 128;
    this.outChunkSize = 128;
    this.previousChunkMessage = {};
    this.connectCmdObj = null;
    this.isFirstAudioReceived = true;
    this.isFirstVideoReceived = true;
    this.lastAudioTimestamp = 0;
    this.lastVideoTimestamp = 0;

    this.public = {};

    this.codec = {
        width: 0,
        height: 0,
        duration: 0,
        framerate: 0,
        videodatarate: 0,
        audiosamplerate: 0,
        audiosamplesize: 0,
        audiodatarate: 0,
        spsLen: 0,
        sps: null,
        ppsLen: 0,
        pps: null
    };
}

RtmpSocket.prototype.initUserAndRoom = function(isPublish, streamStr) {
	var params = myutil.parseQueryString(streamStr);
	var l = 'l', u = 'u', r = 'r';
	var isLogined = parseInt(params[l]),
		userId = params[u],
		roomId = params[r];

	if (isPublish) {
		if (!this.rm[roomId]) {
			console.log('no such room holder');
			return false;
		}
		if (parseInt(userId) !== this.rm[roomId].room.getPublisherId()) {
			console.log('no such publisher');
			return false;
		}

		this.isPublisherStream = true;
		this.user = this.um[userId];
		this.user.setStreamId(this.streamId);

		this.rh = this.rm[roomId];
		this.rh.room.setIsLiving(true);
		if (!this.rh.rtmpConns) {
			this.rh.rtmpConns = {};
		}
		this.rh.rtmpConns[this.streamId] = this;
		if (!this.rh.audiences) {
			this.rh.audiences = [];
		}
		if (!this.rh.damakuSockets) {
			this.rh.damakuSockets = {};
		}
		this.rh.public = this.public;
		this.public = null;

		return true;
	} else {
		this.rh = this.rm[roomId];
		this.rh.rtmpConns[this.streamId] = this;
		if (isLogined === 1) {
			this.user = this.um[userId];
		} else {
			this.user = new User(userId, null, null);
			this.um[userId] = this.user;
		}
		this.user.setStreamId(this.streamId);
		this.rh.audiences.push(userId);
		return true;
	}
};

RtmpSocket.prototype.run = function() {
    setInterval(this.hanshake, 10, this);
};

RtmpSocket.prototype.stop = function() {
    this.isStarting = false;
    this.qb.end();
    
    if (this.isPublisherStream) {
    	this.rh.room.setIsLiving(false);
    	for (var streamId in this.rh.rtmpConns) {
    		var stream = this.rh.rtmpConns[streamId];
    		if (!stream.isPublisherStream) {
    			stream.sendStreamEOF();
    		}
    	}
    } else {
    	this.rh.audiences = myutil.removeFromAry(this.rh.audiences, this.user.getId());
    }

    delete this.rh.rtmpConns[this.streamId];
};

RtmpSocket.prototype.getRealChunkSize = function(rtmpBodySize, chunkSize) {
    var nn = rtmpBodySize + parseInt(rtmpBodySize / chunkSize);
    if (rtmpBodySize % chunkSize) {
        return nn;
    } else {
        return nn - 1;
    }
};

RtmpSocket.prototype.hanshake = function(self) {
    //console.log('hanshake rtmpStatus:' + self.rtmpStatus);
    if (self.rtmpStatus === 0) {
        var c0c1 = self.qb.read(1537, true);
        if (c0c1 == null) return;
        var s0s1s2 = RtmpHandshake.generateS0S1S2(c0c1);
        self.socket.write(s0s1s2);
        self.rtmpStatus = 1;
    } else {
        var c2 = self.qb.read(1536, true);
        if (c2 == null) return;
        self.rtmpStatus = 2;
        clearInterval(this);
        self.isStarting = true;
        self.parseRtmpMessage(self);
    }
};

RtmpSocket.prototype.parseRtmpMessage = function(self) {
    var ret = 0;
    if (!self.isStarting) return;
    do {
        var message = {};
        var chunkMessageHeader = null;
        var previousChunk = null;
        var pos = 0;
        var chunkBasicHeader = self.qb.read(1);
        if (chunkBasicHeader == null) break;

        message.formatType = chunkBasicHeader[0] >> 6;
        message.chunkStreamID = chunkBasicHeader[0] & 0x3F;
        var exStreamID;
        if (message.chunkStreamID === 0) {
            exStreamID = self.qb.read(1);
            if (exStreamID == null) break;
            message.chunkStreamID = exStreamID[0] + 64;
        } else if (message.chunkStreamID == 1) {
            exStreamID = self.qb.read(2);
            if (exStreamID == null) break;
            message.chunkStreamID = (exStreamID[0] << 8) + exStreamID[1] + 64;
        }

        if (message.formatType === 0) {
            // Type 0 (11 bytes)
            chunkMessageHeader = self.qb.read(11);
            if (chunkMessageHeader == null) break;
            message.timestamp = ReadUInt24BE(chunkMessageHeader, 0);
            message.timestampDelta = 0;
            message.messageLength = ReadUInt24BE(chunkMessageHeader, 3);
            message.messageTypeID = chunkMessageHeader[6];
            message.messageStreamID = chunkMessageHeader.readInt32LE(7);
        } else if (message.formatType == 1) {
            // Type 1 (7 bytes)
            chunkMessageHeader = self.qb.read(7);
            if (chunkMessageHeader == null) break;
            message.timestampDelta = ReadUInt24BE(chunkMessageHeader, 0);
            message.messageLength = ReadUInt24BE(chunkMessageHeader, 3);
            message.messageTypeID = chunkMessageHeader[6];
            previousChunk = self.previousChunkMessage[message.chunkStreamID];
            if (previousChunk != null) {
                message.timestamp = previousChunk.timestamp;
                message.messageStreamID = previousChunk.messageStreamID;
            } else {
                throw new Error("Chunk reference error for type 1: previous chunk for id " + message.chunkStreamID + " is not found");
            }
        } else if (message.formatType == 2) {
            // Type 2 (3 bytes)
            chunkMessageHeader = self.qb.read(3);
            if (chunkMessageHeader == null) break;
            message.timestampDelta = ReadUInt24BE(chunkMessageHeader, 0);
            previousChunk = self.previousChunkMessage[message.chunkStreamID];
            if (previousChunk != null) {
                message.timestamp = previousChunk.timestamp;
                message.messageStreamID = previousChunk.messageStreamID;
                message.messageLength = previousChunk.messageLength;
                message.messageTypeID = previousChunk.messageTypeID;
            } else {
                throw new Error("Chunk reference error for type 2: previous chunk for id " + message.chunkStreamID + " is not found");
            }
        } else if (message.formatType == 3) {
            // Type 3 (0 byte)
            previousChunk = self.previousChunkMessage[message.chunkStreamID];
            if (previousChunk != null) {
                message.timestamp = previousChunk.timestamp;
                message.messageStreamID = previousChunk.messageStreamID;
                message.messageLength = previousChunk.messageLength;
                message.timestampDelta = previousChunk.timestampDelta;
                message.messageTypeID = previousChunk.messageTypeID;
            } else {
                throw new Error("Chunk reference error for type 3: previous chunk for id " + message.chunkStreamID + " is not found");
            }
        } else {
            throw new Error("Unknown format type: " + message.formatType);
        }

        //Extended Timestamp
        var chunkBodyHeader;
        if (message.formatType === 0) {
            if (message.timestamp === 0xffffff) {
                chunkBodyHeader = self.qb.read(3);
                if (chunkBodyHeader == null) break;
                message.timestamp = (chunkBodyHeader[0] * Math.pow(256, 3)) + (chunkBodyHeader[1] << 16) + (chunkBodyHeader[2] << 8) + chunkBodyHeader[3];
            }
        } else if (message.timestampDelta === 0xffffff) {
            chunkBodyHeader = self.qb.read(4);
            if (chunkBodyHeader == null) break;
            message.timestampDelta = (chunkBodyHeader[0] * Math.pow(256, 3)) + (chunkBodyHeader[1] << 16) + (chunkBodyHeader[2] << 8) + chunkBodyHeader[3];
        }

        // //console.log(message);

        var rtmpBody = [];
        var rtmpBodySize = message.messageLength;
        var chunkBodySize = self.getRealChunkSize(rtmpBodySize, self.inChunkSize);
        var chunkBody = self.qb.read(chunkBodySize);
        var chunkBodyPos = 0;

        if (chunkBody == null) break;

        do {
            if (rtmpBodySize > self.inChunkSize) {
                rtmpBody.push(chunkBody.slice(chunkBodyPos, chunkBodyPos + self.inChunkSize));
                rtmpBodySize -= self.inChunkSize;
                chunkBodyPos += self.inChunkSize;
                chunkBodyPos++;
            } else {
                rtmpBody.push(chunkBody.slice(chunkBodyPos, chunkBodyPos + rtmpBodySize));
                rtmpBodySize -= rtmpBodySize;
                chunkBodyPos += rtmpBodySize;
            }

        } while (rtmpBodySize > 0);

        message.timestamp += message.timestampDelta;
        self.previousChunkMessage[message.chunkStreamID] = message;
        var rtmpBodyBuf = Buffer.concat(rtmpBody);
        self.handleRtmpMessage(message, rtmpBodyBuf);
        self.qb.commit();
        ret = 1;
    } while (0);
    if (ret === 0) {
        setTimeout(self.parseRtmpMessage, 200, self);
    } else {
        setImmediate(self.parseRtmpMessage, self);
    }
};

RtmpSocket.prototype.createRtmpMessage = function(rtmpHeader, rtmpBody) {
    var formatTypeID = 0;
    var rtmpBodySize = rtmpBody.length;
    if (rtmpHeader.chunkStreamID == null) {
        console.warn("[rtmp] warning: createRtmpMessage(): chunkStreamID is not set for RTMP message");
    }
    if (rtmpHeader.timestamp == null) {
        console.warn("[rtmp] warning: createRtmpMessage(): timestamp is not set for RTMP message");
    }
    if (rtmpHeader.messageTypeID == null) {
        console.warn("[rtmp] warning: createRtmpMessage(): messageTypeID is not set for RTMP message");
    }
    if (rtmpHeader.messageStreamID == null) {
        console.warn("[rtmp] warning: createRtmpMessage(): messageStreamID is not set for RTMP message");
    }

    var useExtendedTimestamp = false;
    var timestamp;

    if (rtmpHeader.timestamp >= 0xffffff) {
        useExtendedTimestamp = true;
        timestamp = [0xff, 0xff, 0xff];
    } else {
        timestamp = [(rtmpHeader.timestamp >> 16) & 0xff, (rtmpHeader.timestamp >> 8) & 0xff, rtmpHeader.timestamp & 0xff];
    }

    var bufs = new Buffer([(formatTypeID << 6) | rtmpHeader.chunkStreamID, timestamp[0], timestamp[1], timestamp[2], (rtmpBodySize >> 16) & 0xff, (rtmpBodySize >> 8) & 0xff, rtmpBodySize & 0xff, rtmpHeader.messageTypeID, rtmpHeader.messageStreamID & 0xff, (rtmpHeader.messageStreamID >>> 8) & 0xff, (rtmpHeader.messageStreamID >>> 16) & 0xff, (rtmpHeader.messageStreamID >>> 24) & 0xff]);

    if (useExtendedTimestamp) {
        var extendedTimestamp = new Buffer([(rtmpHeader.timestamp >> 24) & 0xff, (rtmpHeader.timestamp >> 16) & 0xff, (rtmpHeader.timestamp >> 8) & 0xff, rtmpHeader.timestamp & 0xff]);
        bufs = Buffer.concat([bufs, extendedTimestamp]);
    }


    var rtmpBodyPos = 0;
    var chunkBodySize = this.getRealChunkSize(rtmpBodySize, this.outChunkSize);
    var chunkBody = [];
    var type3Header = new Buffer([(3 << 6) | rtmpHeader.chunkStreamID]);

    do {
        if (rtmpBodySize > this.outChunkSize) {
            chunkBody.push(rtmpBody.slice(rtmpBodyPos, rtmpBodyPos + this.outChunkSize));
            rtmpBodySize -= this.outChunkSize;
            rtmpBodyPos += this.outChunkSize;
            chunkBody.push(type3Header);
        } else {
            chunkBody.push(rtmpBody.slice(rtmpBodyPos, rtmpBodyPos + rtmpBodySize));
            rtmpBodySize -= rtmpBodySize;
            rtmpBodyPos += rtmpBodySize;
        }

    } while (rtmpBodySize > 0);
    var chunkBodyBuffer = Buffer.concat(chunkBody);
    bufs = Buffer.concat([bufs, chunkBodyBuffer]);
    return bufs;
};

RtmpSocket.prototype.handleRtmpMessage = function(rtmpHeader, rtmpBody) {
    var cmd;
    switch (rtmpHeader.messageTypeID) {
        case 0x01:
            this.inChunkSize = rtmpBody.readUInt32BE(0);
            break;

        case 0x04:
            var userControlMessage = this.parseUserControlMessage(rtmpBody);
            if (userControlMessage.eventType === 3) {
                var streamID = (userControlMessage.eventData[0] << 24) + (userControlMessage.eventData[1] << 16) + (userControlMessage.eventData[2] << 8) + userControlMessage.eventData[3];
                var bufferLength = (userControlMessage.eventData[4] << 24) + (userControlMessage.eventData[5] << 16) + (userControlMessage.eventData[6] << 8) + userControlMessage.eventData[7];
                // //console.log("[rtmp handleRtmpMessage] SetBufferLength: streamID=" + streamID + " bufferLength=" + bufferLength);
            } else if (userControlMessage.eventType === 7) {
                var timestamp = (userControlMessage.eventData[0] << 24) + (userControlMessage.eventData[1] << 16) + (userControlMessage.eventData[2] << 8) + userControlMessage.eventData[3];
                ////console.log("[rtmp handleRtmpMessage] PingResponse: timestamp=" + timestamp);
            } else {
                // //console.log("[rtmp handleRtmpMessage] User Control Message");
                //console.log(userControlMessage);
            }
            break;

        case 0x08:
            //Audio Data
            this.parseAudioMessage(rtmpHeader, rtmpBody);
            break;

        case 0x09:
            //Video Data
            this.parseVideoMessage(rtmpHeader, rtmpBody);
            break;

        case 0x12:
            //AMF0 Data
            cmd = AMF.decodeAmf0Cmd(rtmpBody);
            this.handleAMFDataMessage(cmd, this);
            break;

        case 0x14:
            //AMF0 Command
            cmd = AMF.decodeAmf0Cmd(rtmpBody);
            this.handleAMFCommandMessage(cmd, this);
            break;
    }
};

RtmpSocket.prototype.handleAMFDataMessage = function(cmd) {
    switch (cmd.cmd) {
        case '@setDataFrame':
            this.receiveSetDataFrame(cmd.method, cmd.cmdObj);
            break;
        default:
            //console.warn("[rtmp:receive] unknown AMF data: " + dataMessage.objects[0].value);
    }
};

RtmpSocket.prototype.handleAMFCommandMessage = function(cmd) {
    switch (cmd.cmd) {
        case 'connect':
            this.connectCmdObj = cmd.cmdObj;
            this.windowACK(2500000);
            this.setPeerBandwidth(2500000, 2);
            this.outChunkSize = 4000;
            this.setChunkSize(this.outChunkSize);
            this.respondConnect();
            break;

        case 'createStream':
            this.respondCreateStream(cmd);
            break;

        case 'play':
            console.log('client want to play stream ' + cmd.streamName);
			this.initUserAndRoom(false, cmd.streamName);

			this.respondPlay();
			this.startPlay();
			break;

		case 'publish':
            console.log('publisher want to publish stream ' + cmd.name);

			// when there are more than 1 publisher who want to publish the same streamName, 
			// give the later one a error response
			if (!this.initUserAndRoom(true, cmd.name)) {
				console.log('bad publish stream name ' + cmd.name);
				this.respondPublishError();
				return;
			}
			this.respondPublish();
			break;

        case 'closeStream':
            this.closeStream();
            break;

        case 'deleteStream':
            this.deleteStream();
            break;

        case 'pause':
            //console.log('pause received');
            this.pauseOrUnpauseStream();
            break;

        case 'releaseStream':
            this.respondReleaseStream();
            break;

        case 'FCPublish':
            this.respondFCPublish();
            break;

        case 'FCUnpublish':
            this.respondFCUnpublish();
            break;

        default:
            //console.warn("[rtmp:receive] unknown AMF command: " + cmd.cmd);
            break;

    }
};

RtmpSocket.prototype.windowACK = function(size) {
    var rtmpBuffer = new Buffer('02000000000004050000000000000000', 'hex');
    rtmpBuffer.writeUInt32BE(size, 12);
    // //console.log('windowACK: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
};

RtmpSocket.prototype.setPeerBandwidth = function(size, type) {
    var rtmpBuffer = new Buffer('0200000000000506000000000000000000', 'hex');
    rtmpBuffer.writeUInt32BE(size, 12);
    rtmpBuffer[16] = type;
    // //console.log('setPeerBandwidth: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
};

RtmpSocket.prototype.setChunkSize = function(size) {
    var rtmpBuffer = new Buffer('02000000000004010000000000000000', 'hex');
    rtmpBuffer.writeUInt32BE(size, 12);
    // //console.log('setChunkSize: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
};

RtmpSocket.prototype.respondConnect = function() {
    var rtmpHeader = {
        chunkStreamID: 3,
        timestamp: 0,
        messageTypeID: 0x14,
        messageStreamID: 0
    };
    var opt = {
        cmd: '_result',
        transId: 1,
        cmdObj: {
            fmsVer: 'FMS/3,0,1,123',
            capabilities: 31
        },
        info: {
            level: 'status',
            code: 'NetConnection.Connect.Success',
            description: 'Connection succeeded.',
            objectEncoding: 0
        }
    };
    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
};

RtmpSocket.prototype.respondRejectConnect = function(first_argument) {
    var rtmpHeader = {
        chunkStreamID: 3,
        timestamp: 0,
        messageTypeID: 0x14,
        messageStreamID: 0
    };

    var opt = {
        cmd: '_error',
        transId: 1,
        cmdObj: {
            fmsVer: 'FMS/3,0,1,123',
            capabilities: 31
        },
        info: {
            level: 'error',
            code: 'NetConnection.Connect.Rejected',
            description: 'Connection failed.',
            objectEncoding: 0
        }
    };
    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
};

RtmpSocket.prototype.respondCreateStream = function(cmd) {
    // //console.log(cmd);
    var rtmpHeader = {
        chunkStreamID: 3,
        timestamp: 0,
        messageTypeID: 0x14,
        messageStreamID: 0
    };
    var opt = {
        cmd: "_result",
        transId: cmd.transId,
        cmdObj: null,
        info: 1,
        objectEncoding: 0

    };
    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);

};

RtmpSocket.prototype.respondPlay = function() {
    var rtmpHeader = {
        chunkStreamID: 3,
        timestamp: 0,
        messageTypeID: 0x14,
        messageStreamID: 1
    };
    var opt = {
        cmd: 'onStatus',
        transId: 0,
        cmdObj: null,
        info: {
            level: 'status',
            code: 'NetStream.Play.Start',
            description: 'Start live'
        }
    };
    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);

    rtmpHeader = {
        chunkStreamID: 5,
        timestamp: 0,
        messageTypeID: 0x12,
        messageStreamID: 1
    };
    opt = {
        cmd: '|RtmpSampleAccess',
        bool1: true,
        bool2: true
    };

    rtmpBody = AMF.encodeAmf0Cmd(opt);
    rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
};

RtmpSocket.prototype.startPlay = function() {
    var public = this.rh.public;
    if (public.metaData === null || public.cacheAudioSequenceBuffer === null || public.cacheVideoSequenceBuffer === null) {
    	return;
    }

    var rtmpHeader = {
        chunkStreamID: 5,
        timestamp: 0,
        messageTypeID: 0x12,
        messageStreamID: 1
    };

    var opt = {
        cmd: 'onMetaData',
        cmdObj: public.metaData
    };

    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var metaDataRtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);


    rtmpHeader = {
        chunkStreamID: 4,
        timestamp: 0,
        messageTypeID: 0x08,
        messageStreamID: 1
    };
    var audioSequenceRtmpMessage = this.createRtmpMessage(rtmpHeader, public.cacheAudioSequenceBuffer);


    rtmpHeader = {
        chunkStreamID: 4,
        timestamp: 0,
        messageTypeID: 0x09,
        messageStreamID: 1
    };
    var videoSequenceRtmpMessage = this.createRtmpMessage(rtmpHeader, public.cacheVideoSequenceBuffer);

    var beginRtmpMessage = new Buffer("020000000000060400000000000000000001", 'hex');
    this.sendBufferQueue.push(beginRtmpMessage);
    this.sendBufferQueue.push(metaDataRtmpMessage);
    this.sendBufferQueue.push(audioSequenceRtmpMessage);
    this.sendBufferQueue.push(videoSequenceRtmpMessage);
    this.sendRtmpMessage(this);
};

RtmpSocket.prototype.closeStream = function() {};

RtmpSocket.prototype.deleteStream = function() {};

RtmpSocket.prototype.pauseOrUnpauseStream = function() {};

RtmpSocket.prototype.respondReleaseStream = function() {};

RtmpSocket.prototype.respondFCPublish = function() {};

RtmpSocket.prototype.respondFCUnpublish = function() {};

RtmpSocket.prototype.respondPublish = function() {
    var rtmpHeader = {
        chunkStreamID: 5,
        timestamp: 0,
        messageTypeID: 0x14,
        messageStreamID: 1
    };
    var opt = {
        cmd: 'onStatus',
        transId: 0,
        cmdObj: null,
        info: {
            level: 'status',
            code: 'NetStream.Publish.Start',
            description: 'Start publishing'
        }
    };
    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);

};

RtmpSocket.prototype.respondPublishError = function() {
    var rtmpHeader = {
        chunkStreamID: 5,
        timestamp: 0,
        messageTypeID: 0x14,
        messageStreamID: 1
    };
    var opt = {
        cmd: 'onStatus',
        transId: 0,
        cmdObj: null,
        info: {
            level: 'error',
            code: 'NetStream.Publish.BadName',
            description: 'Already publishing'
        }
    };
    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
};

RtmpSocket.prototype.receiveSetDataFrame = function(method, obj) {
    //console.log('[receiveSetDataFrame] method:' + method);

    if (method == 'onMetaData') {
        this.public = obj;
    }

};

RtmpSocket.prototype.parseUserControlMessage = function(buf) {
    var eventType = (buf[0] << 8) + buf[1];
    var eventData = buf.slice(2);
    var message = {
        eventType: eventType,
        eventData: eventData
    };
    if (eventType === 3) {
        message.streamID = (eventData[0] << 24) + (eventData[1] << 16) + (eventData[2] << 8) + eventData[3];
        message.bufferLength = (eventData[4] << 24) + (eventData[5] << 16) + (eventData[6] << 8) + eventData[7];
    }
    return message;
};

RtmpSocket.prototype.parseAudioMessage = function(rtmpHeader, rtmpBody) {
    if (this.isFirstAudioReceived) {
        var sound_format = rtmpBody[0];
        var sound_type = sound_format & 0x01;
        var sound_size = (sound_format >> 1) & 0x01;
        var sound_rate = (sound_format >> 2) & 0x03;
        sound_format = (sound_format >> 4) & 0x0f;
        if (sound_format != 10) {
            //console.error("Only support audio aac codec. actual=" + sound_format);
            return -1;
        }
        //console.info(this.id + " Parse AudioTagHeader sound_format=" + sound_format + " sound_type=" + sound_type + " sound_size=" + sound_size + " sound_rate=" + sound_rate);
        var aac_packet_type = rtmpBody[1];
        if (aac_packet_type === 0) {
            //AudioSpecificConfig
            // only need to decode  2bytes:
            // audioObjectType, aac_profile, 5bits.
            // samplingFrequencyIndex, aac_sample_rate, 4bits.
            // channelConfiguration, aac_channels, 4bits
            this.codec.aac_profile = rtmpBody[2];
            this.codec.aac_sample_rate = rtmpBody[3];

            this.codec.aac_channels = (this.codec.aac_sample_rate >> 3) & 0x0f;
            this.codec.aac_sample_rate = ((this.codec.aac_profile << 1) & 0x0e) | ((this.codec.aac_sample_rate >> 7) & 0x01);
            this.codec.aac_profile = (this.codec.aac_profile >> 3) & 0x1f;
            this.codec.audiosamplerate = aac_sample_rates[this.codec.aac_sample_rate];
            if (this.codec.aac_profile === 0 || this.codec.aac_profile === 0x1f) {
                //console.error("Parse audio aac sequence header failed, adts object=" + this.codec.aac_profile + "invalid.");
                return -1;
            }
            this.codec.aac_profile--;
            //console.info("Parse audio aac sequence header success! ");
            // //console.info(this.codec);
            this.isFirstAudioReceived = false;

            this.rh.public.cacheAudioSequenceBuffer = new Buffer(rtmpBody);
            
            if (this.isPublisherStream) {
            	for (var streamId in this.rh.rtmpConns) {
            		otherStream = this.rh.rtmpConns[streamId];
            		if (!otherStream.isPublisherStream) {
            			otherStream.startPlay();
            		}
            	}
            }
        }

    } else {
        var sendRtmpHeader = {
            chunkStreamID: 4,
            timestamp: rtmpHeader.timestamp,
            messageTypeID: 0x08,
            messageStreamID: 1
        };
        var rtmpMessage = this.createRtmpMessage(sendRtmpHeader, rtmpBody);

        if (this.isPublisherStream) {
        	for (var streamId in this.rh.rtmpConns) {
        		otherStream = this.rh.rtmpConns[streamId];
        		if (!otherStream.isPublisherStream) {
        			otherStream.sendBufferQueue.push(rtmpMessage);
        		}
        	}
        }
    }
};

RtmpSocket.prototype.parseVideoMessage = function(rtmpHeader, rtmpBody) {
    var index = 0;
    var frame_type = rtmpBody[0];
    var codec_id = frame_type & 0x0f;
    frame_type = (frame_type >> 4) & 0x0f;
    // only support h.264/avc
    if (codec_id != 7) {
        //console.error("Only support video h.264/avc codec. actual=" + codec_id);
        return -1;
    }
    var avc_packet_type = rtmpBody[1];
    var composition_time = ReadUInt24BE(rtmpBody, 2);
    //  printf("v composition_time %d\n",composition_time);

    if (avc_packet_type === 0) {
        if (this.isFirstVideoReceived) {
            //AVC sequence header
            var configurationVersion = rtmpBody[5];
            this.codec.avc_profile = rtmpBody[6];
            var profile_compatibility = rtmpBody[7];
            this.codec.avc_level = rtmpBody[8];
            var lengthSizeMinusOne = rtmpBody[9];
            lengthSizeMinusOne &= 0x03;
            this.codec.NAL_unit_length = lengthSizeMinusOne;

            //  sps
            var numOfSequenceParameterSets = rtmpBody[10];
            numOfSequenceParameterSets &= 0x1f;

            if (numOfSequenceParameterSets != 1) {
                //console.error("Decode video avc sequenc header sps failed.\n");
                return -1;
            }

            this.codec.spsLen = rtmpBody.readUInt16BE(11);

            index = 11 + 2;
            if (this.codec.spsLen > 0) {
                this.codec.sps = new Buffer(this.codec.spsLen);
                rtmpBody.copy(this.codec.sps, 0, 13, 13 + this.codec.spsLen);
            }
            // pps
            index += this.codec.spsLen;
            var numOfPictureParameterSets = rtmpBody[index];
            numOfPictureParameterSets &= 0x1f;
            if (numOfPictureParameterSets != 1) {
                //console.error("Decode video avc sequenc header pps failed.\n");
                return -1;
            }

            index++;
            this.codec.ppsLen = rtmpBody.readUInt16BE(index);
            index += 2;
            if (this.codec.ppsLen > 0) {
                this.codec.pps = new Buffer(this.codec.ppsLen);
                rtmpBody.copy(this.codec.pps, 0, index, index + this.codec.ppsLen);
            }
            this.isFirstVideoReceived = false;

            this.rh.public.cacheVideoSequenceBuffer = new Buffer(rtmpBody);
            if (this.isPublisherStream) {
            	for (var streamId in this.rh.rtmpConns) {
            		otherStream = this.rh.rtmpConns[streamId];
            		if (!otherStream.isPublisherStream) {
            			otherStream.startPlay();
            		}
            	}
            }
        }
    } else if (avc_packet_type == 1) {
        var sendRtmpHeader = {
            chunkStreamID: 4,
            timestamp: rtmpHeader.timestamp,
            messageTypeID: 0x09,
            messageStreamID: 1
        };
        var rtmpMessage = this.createRtmpMessage(sendRtmpHeader, rtmpBody);

        if (this.isPublisherStream) {
        	for (var streamId in this.rh.rtmpConns) {
        		otherStream = this.rh.rtmpConns[streamId];
        		if (!otherStream.isPublisherStream) {
        			otherStream.sendBufferQueue.push(rtmpMessage);
        		}
        	}
        }
    } else {
        //AVC end of sequence (lower level NALU sequence ender is not required or supported)
    }
};

RtmpSocket.prototype.sendStreamEOF = function() {
    var rtmpBuffer = new Buffer("020000000000060400000000000100000001", 'hex');
    this.socket.write(rtmpBuffer);
};

RtmpSocket.prototype.sendRtmpMessage = function(self) {
    if (!self.isStarting) return;
    var len = self.sendBufferQueue.length;
    for (var i = 0; i < len; i++) {
        self.socket.write(self.sendBufferQueue.shift());
    }
    if (len === 0) {
        setTimeout(self.sendRtmpMessage, 200, self);
    } else {
        setImmediate(self.sendRtmpMessage, self);
    }
};

module.exports = RtmpSocket;