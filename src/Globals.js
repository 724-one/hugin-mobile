// Copyright (C) 2018, Zpalmtree
//
// Please see the included LICENSE file for more information.

const request = require('request-promise-native');

import * as _ from 'lodash';

import { Daemon } from 'kryptokrona-wallet-backend-js';

import { Alert } from 'react-native';

import NetInfo from "@react-native-community/netinfo";

import { getKnownTransactions, getUnreadMessages, getGroupMessages, saveGroupToDatabase, removeMessages, loadPayeeDataFromDatabase, savePayeeToDatabase, removePayeeFromDatabase,
loadTransactionDetailsFromDatabase, saveTransactionDetailsToDatabase, removeGroupFromDatabase, getMessages, getLatestMessages, getBoardsMessages, getBoardSubscriptions, loadGroupsDataFromDatabase } from './Database';
import Config from './Config';

import { Logger } from './Logger';
import { getCoinPriceFromAPI } from './Currency';
import { makePostRequest } from './NativeCode';
import { getBestCache } from './HuginUtilities';
import offline_node_list from './nodes.json';
import offline_cache_list from './apis.json';
import offline_groups_list from './groups.json';

class globals {
    constructor() {
        /* Can't really pass wallet between tab screens, and need it everywhere */
        this.wallet = undefined;

        /* Need to be able to cancel the background saving if we make a new wallet */
        this.backgroundSaveTimer = undefined;

        /* Want to cache this so we don't have to keep loading from DB/internet */
        this.coinPrice = 0;

        this.syncingMessages = false;

        this.syncingMessagesCount = 0;

        /* Preferences loaded from DB */
        this.preferences = {
            currency: 'usd',
            notificationsEnabled: true,
            scanCoinbaseTransactions: false,
            limitData: false,
            theme: 'darkMode',
            authConfirmation: false,
            autoOptimize: false,
            authenticationMethod: 'hardware-auth',
            node: Config.defaultDaemon.getConnectionString(),
            language: 'en',
            cache: Config.defaultCache,
            nickname: 'Anonymous'
        };

        /* People in our address book */
        this.payees = [];

        this.groups = [];

        this.logger = new Logger();

        this.updatePayeeFunctions = [];

        this.updateGroupsFunctions = [];

        this.updateChatFunctions = [];

        this.updateCallFunctions = [];

        this.updateBoardsFunctions = [];

        /* Mapping of tx hash to address sent, payee name, memo */
        this.transactionDetails = [];

        this.daemons = [];

        this.caches = [];

        this.standardGroups = [];

        this.messages = [];

        this.boardsMessages = [];

        this.groupMessages = [];

        this.knownTXs = [];

        this.activeChat = '';

        this.activeBoard = '';

        this.language = 'en-US';

        this.fromChat = false;

        this.unreadMessages = {boards: 0, groups: 0, pms: 0};

        this.sdp_answer = '';

        this.calls = [];

        this.stream = false;

        this.localWebcamOn = false;
        
        this.localMicOn = false;

        this.speakerOn = true;

    }

    reset() {
        this.wallet = undefined;
        this.pinCode = undefined;
        this.backgroundSaveTimer = undefined;
        this.logger = new Logger();
        this.payees = [];
        this.groups = [];
        removeMessages();
    }

    addTransactionDetails(txDetails) {
        Globals.transactionDetails.push(txDetails);
        saveTransactionDetailsToDatabase(txDetails);
    }

    addPayee(payee) {
        Globals.payees.push(payee);
        savePayeeToDatabase(payee);
        this.update();
        this.updateMessages();
    }

    removePayee(nickname, removeMessages) {
        _.remove(Globals.payees, (item) => item.nickname === nickname);
        removePayeeFromDatabase(nickname, removeMessages);
        this.update();
    }

    update() {
        Globals.updatePayeeFunctions.forEach((f) => {
            f();
        });
    }

    updateGroupsFunction() {
      Globals.updateGroupsFunctions.forEach((f) => {
          f();
      });
    }


    addGroup(group) {
        if (Globals.groups.some((g) => g.key == group.key)) {
            console.log('Group already exists!');
            return;
        }
        Globals.groups.push(group);
        saveGroupToDatabase(group);
        this.updateGroups();
    }

    removeGroup(key, removeMessages) {
        _.remove(Globals.group, (item) => item.key === key);
        removeGroupFromDatabase(key, removeMessages);
        this.updateGroups();
    }


      async updateGroups() {

        const groups = await loadGroupsDataFromDatabase();

        if (groups !== undefined) {
            Globals.groups = groups;
        }

        this.groupMessages = await getGroupMessages();
        this.updateGroupsFunction();

      }

    async updateMessages() {
      this.messages = await getMessages();
      this.updateChat();
      let payees = await loadPayeeDataFromDatabase();

      if (payees !== undefined) {
          Globals.payees = payees;
      }

      this.update();

    }

    async updateBoardsMessages() {
      console.log(Globals.activeBoard);
      if (Globals.activeBoard != '') {
          this.boardsMessages = await getBoardsMessages(this.activeBoard);
      } else if (Globals.activeBoard == 'Home' || Globals.activeBoard == '') {
        this.boardsMessages = await getBoardsMessages();
      }
      Globals.boardsSubscriptions = await getBoardSubscriptions();
      this.updateBoards();

    }

    //
    // updateKnownTXs() {
    //
    // }

    updateChat() {
      console.log('updateChat');
      Globals.updateChatFunctions.forEach((f) => {
          f();
      });
    }

    updateCall() {
        console.log('updateCall');
        Globals.updateCallFunctions.forEach((f) => {
            f();
        });
      }

    updateBoards() {
      console.log('updateChat');
      Globals.updateBoardsFunctions.forEach((f) => {
          f();
      });
    }

    getDaemon() {
        const [ host, port, ssl ] = this.preferences.node.split(':');

        let ssl_formatted = false;
        if (ssl == 'true') {
          ssl_formatted = true;
        }

        const daemon = new Daemon(host, Number(port), false, ssl_formatted);

        if (Platform.OS === 'android') {
            /* Override with our native makePostRequest implementation which can
               actually cancel requests part way through */
            daemon.makePostRequest = makePostRequest;
        }

        return daemon;
    }

    async updateNodeList() {
        try {
            const data = await request({
                json: true,
                method: 'GET',
                timeout: Config.requestTimeout,
                url: Config.nodeListURL,
            });

            if (data.nodes) {
                this.daemons = data.nodes;
            } else {
              this.daemons = offline_node_list.nodes;
            }
        } catch (error) {
          console.log(offline_node_list);
            this.logger.addLogMessage('Failed to get node list from API: ' + error.toString());
            this.daemons = offline_node_list.nodes;
        }
    }

    async updateCacheList() {
        try {
            const data = await request({
                json: true,
                method: 'GET',
                timeout: Config.requestTimeout,
                url: Config.nodeListURL,
            });
            console.log(data);
            if (data.apis) {
                this.caches = data.apis;
            } else {
              this.caches = offline_node_list.apis;
            }
        } catch (error) {
          console.log(offline_cache_list);
            this.logger.addLogMessage('Failed to get api list from API: ' + error.toString());
            this.daemons = offline_cache_list.apis;
        }
    }

    async updateGroupsList() {
        try {
            const data = await request({
                json: true,
                method: 'GET',
                timeout: Config.requestTimeout,
                url: Config.groupsListURL,
            });
            console.log(data);
            if (data.apis) {
                this.standardGroups = data.groups;
            } else {
              this.standardGroups = offline_groups_list.groups;
            }
        } catch (error) {
          console.log(offline_cache_list);
            this.logger.addLogMessage('Failed to get groups list from API: ' + error.toString());
            this.standardGroups = offline_groups_list.groups;
        }
    }

}

export let Globals = new globals();

function updateConnection(connection) {
    if (Globals.preferences.limitData && connection.type === 'cellular') {
        Globals.wallet.stop();
    } else {
        Globals.wallet.start();
        Globals.wallet.enableAutoOptimization(false);
    }
}

/* Note... you probably don't want to await this function. Can block for a while
   if no internet. */
export async function initGlobals() {

    const payees = await loadPayeeDataFromDatabase();

    if (payees !== undefined) {
        Globals.payees = payees;
    }

    Globals.knownTXs = await getKnownTransactions();

    const groups = await loadGroupsDataFromDatabase();

    Globals.groups = groups;

    Globals.boardsSubscriptions = await getBoardSubscriptions();

    Globals.unreadMessages = await getUnreadMessages();

    const transactionDetails = await loadTransactionDetailsFromDatabase();

    if (transactionDetails !== undefined) {
        Globals.transactionDetails = transactionDetails;
    }

    const netInfo = await NetInfo.fetch();

    /* Start syncing */
    if ((Globals.preferences.limitData && netInfo.type === 'cellular')) {
        Alert.alert(
            'Not Syncing',
            'You enabled data limits, and are on a limited connection. Not starting sync.',
            [
                {text: 'OK'},
            ]
        );
    } else {
        Globals.wallet.start();
        Globals.wallet.enableAutoOptimization(false);
    }

    await Globals.updateNodeList();
    await Globals.updateGroupsList();
}
