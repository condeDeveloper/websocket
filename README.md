# websocket

Um servidor WebSocket escrito do zero sobre `node:http` e `node:net`, seguindo
a RFC 6455: aperto de mão, quadros, máscara, fragmentação, ping/pong e
fechamento em duas vias. Vem com um cliente, porque sem ele não dá para testar
o servidor sem depender de ninguém. **Zero dependências.**

```js
import { ServidorWebSocket } from 'websocket-do-zero';

const servidor = new ServidorWebSocket({ caminho: '/sala', batimento: 30_000 });

servidor.on('conexao', (conexao) => {
  conexao.enviar('Bem-vindo.');

  conexao.on('mensagem', ({ tipo, dados }) => {
    if (tipo === 'texto') servidor.transmitir(dados, conexao);
  });
});

await servidor.escutar(8080);
```

Do outro lado, o `WebSocket` do navegador conversa com ele sem adaptação
nenhuma:

```js
const ws = new WebSocket('ws://127.0.0.1:8080/sala');
ws.onmessage = (e) => console.log(e.data);
ws.send('oi');
```

O exemplo completo (`node exemplos/eco.js`) é uma sala de bate-papo:

```
Sala aberta em ws://127.0.0.1:8080/sala
+ visitante-1 entrou de 127.0.0.1
+ visitante-2 entrou de 127.0.0.1
- visitante-2 saiu (1000)
```

## Por que existe

WebSocket parece opaco porque quase todo mundo o conhece pela API do navegador,
que é três métodos. Por baixo é um protocolo pequeno — e cada decisão dele tem
um motivo que explica um bug que você provavelmente já viu.

### 1. O aperto de mão é HTTP de propósito

A conexão começa como um `GET` comum com `Upgrade: websocket`. O servidor
responde `101` e, do mesmo soquete TCP em diante, ninguém mais fala HTTP.

É por isso que WebSocket atravessa proxy e firewall que só conhecem as portas
80 e 443: a abertura é indistinguível de uma requisição normal. E é por isso
que dá para servir a página e o WebSocket dela na **mesma porta**.

O `Sec-WebSocket-Accept` — SHA-1 da chave do cliente com uma constante pública
da RFC — **não é segurança**. A constante está publicada. Ele existe para
provar que do outro lado há algo que entende WebSocket, e não um cache velho
devolvendo uma resposta guardada.

### 2. A máscara não é criptografia

Todo quadro que o cliente manda é XOR com uma chave de 4 bytes… que viaja no
próprio quadro. Não esconde nada, e não deveria: serve para impedir que um
cliente hostil faça o navegador emitir bytes que um proxy antigo leia como se
fossem uma requisição HTTP *dele* — o ataque de envenenamento de cache que
motivou a regra.

Por isso o sentido importa: o **cliente tem que mascarar**, o **servidor não
pode**. Este servidor derruba a conexão com 1002 nos dois casos errados.

### 3. TCP entrega bytes, não mensagens

Um evento `data` pode trazer meio cabeçalho; dois quadros podem chegar no
mesmo. Sem um buffer acumulador e um leitor que devolve `null` enquanto falta
byte, o código funciona no teste local e quebra na primeira rede de verdade.

Há um teste que corta um quadro em **todas** as posições possíveis e exige
`null` em cada uma delas.

### 4. Quadro de controle não pode ser fragmentado

Ping, pong e fechamento cabem em 125 bytes e vêm sempre inteiros. É o que
permite responder um ping **no meio** de uma mensagem de 10 MB que ainda está
chegando — e é o que torna o batimento cardíaco possível.

Sem batimento, uma conexão cortada por NAT fica "aberta" dos dois lados até
alguém tentar escrever. Pode levar horas. Com ping periódico, leva segundos.

### 5. Fechar é uma conversa, não um `destroy`

Quem fecha manda um quadro de fechamento e **espera o eco**. Derrubar o soquete
na hora descarta o que já estava a caminho — a mensagem que o outro lado achou
que tinha entregue.

E texto inválido em UTF-8 não é "texto estranho": pela RFC é erro de protocolo,
e fecha com 1007. É o que separa um servidor conforme de um que entrega lixo
para a aplicação.

## A API

```js
// servidor
new ServidorWebSocket({ servidor, caminho, protocolos, verificar, batimento, maximoDeMensagem })
servidor.escutar(porta, endereco)      servidor.transmitir(dados, menos)
servidor.conexoes                      servidor.fechar()
// eventos: conexao, recusa, erro

// conexão
conexao.enviar(texto | Buffer)         conexao.enviarEmPedacos(dados, tamanho)
conexao.ping(carga)                    conexao.fechar(codigo, motivo)
conexao.estado                         'aberta' | 'fechando' | 'fechada'
// eventos: mensagem ({tipo, dados}), ping, pong, fechando, fechada, erro

// cliente
const conexao = await conectar('ws://…', { protocolos, cabecalhos, prazo });
```

`verificar` roda antes do `101`, então dá para exigir cabeçalho, cookie ou
origem e recusar **antes** de a conexão existir — com status e motivo no corpo,
em vez de um soquete que abre, fica mudo e cai.

## Estrutura

```
src/aperto.js    o GET, o 101, a chave e o subprotocolo
src/quadro.js    ler e montar quadros, máscara, códigos de fechamento
src/conexao.js   a máquina de estados: remontagem, fragmentação, controle
src/servidor.js  o evento `upgrade`, transmissão e batimento
src/cliente.js   o outro lado, que mascara — e que os testes usam
```

## Rodando

```bash
npm test        # 71 testes
npm run exemplo # a sala de bate-papo em ws://127.0.0.1:8080/sala
```

Os testes de quadro usam os **vetores da própria RFC 6455 §5.7** (o `Hello`
mascarado e o sem máscara, o fragmentado, o ping, os 256 bytes e os 64 KiB), e
o `Sec-WebSocket-Accept` é conferido contra o par de valores publicado na
especificação. Os de integração sobem servidor e cliente em soquete real, sem
simulação.

Node 20 ou mais novo.

## Limites conhecidos

- **Sem extensões**, então sem `permessage-deflate`. Quadro com bit RSV ligado
  é recusado, que é o comportamento certo para quem não negociou extensão
  nenhuma.
- **Sem servidor TLS embutido.** O cliente fala `wss://`; para servir, passe um
  `https.Server` pronto em `servidor`.
- **Sem limite de vazão por conexão.** Um cliente pode mandar mensagens tão
  rápido quanto conseguir; há limite de *tamanho*, não de *ritmo*.
- **Sem controle de contrapressão.** `enviar` escreve no soquete sem olhar o
  `writableLength`; para arquivos grandes, `enviarEmPedacos` ajuda mas não
  resolve.
- Não é um cliente completo: sem reconexão automática e sem fila de envio.
- Não passa a suíte Autobahn inteira — cobre o núcleo do protocolo, não todos
  os casos-limite de UTF-8 e fragmentação que ela testa.

## Licença

MIT.
