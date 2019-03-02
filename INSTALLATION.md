# Installation (Ubuntu/Debian)
This is a simple guide how to install your own private pool with a self-signed certificate and no payouts.
***
Update the system
```
sudo apt-get update
sudo apt-get upgrade -y --with-new-pkgs
```

Install Git and build tools
```
sudo apt-get install -y git build-essential
```

Install MariaDB (MySQL)
```
sudo apt-get install -y mariadb-server
```

Harden the security, set the root password, asnwer Y to all questions
```
sudo mysql_secure_installation
```

Install NodeJS
```
curl -sL https://deb.nodesource.com/setup_10.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Update NPM
```
sudo -H npm i -g npm
```

Install PM2
```
sudo -H npm i -g pm2
```

Clone and build the Nimiq pool
```
mkdir nimiq-pool && cd nimiq-pool
git clone https://github.com/tomkha/mining-pool.git ./
npm install
```

Create the database
```
sudo mysql -u root < sql/create.sql
```

Generate a self-signed certificate
```
openssl req -x509 -nodes -keyout mypool.key -out mypool.cer -days 365 -subj '/CN=MyPool'
```

Download and unpack the full consensus archive (be patient)
```
mkdir main-full-consensus && cd main-full-consensus
wget https://download.sushipool.com/main-full-consensus.tar.bz2
tar -xvf main-full-consensus.tar.bz2
rm main-full-consensus.tar.bz2
cd ..
```

Modify the config file, set your wallet address and other parameters
```
cp combined.sample.conf combined.conf
nano combined.conf
```

Run the pool
```
pm2 start index.js --name 'My pool' -- --config=combined.conf
```

Run the miner
```
NODE_TLS_REJECT_UNAUTHORIZED=0 ./your-miner-cmd
```

