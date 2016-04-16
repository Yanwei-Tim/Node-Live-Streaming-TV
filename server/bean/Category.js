/*
 * @File:   Category.js
 * @Author: yintaibing, SCUT Software Engineering, Grade 2012, Class 6.
 * @Date:   2016/04/15
 */

'use strict';

var Util = require('util');
var BaseBean = require('./BaseBean.js');

function Category(id, name, coverPath) {
	BaseBean.call(this, id);

	this.name = name;
	this.coverPath = coverPath;
}

Util.inherits(Category, BaseBean);

Category.prototype.getName = function() {
	return this.name;
};

Category.prototype.setName = function(name) {
	this.name = name;
};

Category.prototype.getCoverPath = function() {
	return this.coverPath;
};

Category.prototype.setCoverPath = function(coverPath) {
	this.coverPath = coverPath;
};

module.exports = Category;