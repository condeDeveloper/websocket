import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ErroDeAperto,
  GUID,
  VERSAO,
  chaveNova,
  conferirPedido,
  escolherProtocolo,
  resposta101,
  respostaDeRecusa,
  respostaPara,
} from '../src/aperto.js';
import { ErroDeConexao, lerEndereco, lerResposta, pedidoDeUpgrade } from '../src/cliente.js';

/** Um pedido de upgrade válido, para mexer num campo por vez. */
function pedido(trocas = {}) {
  return {
    method: 'GET',
    url: '/',
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      ...trocas,
    },
  };
}

describe('a resposta do aperto de mão', () => {
  it('bate com o exemplo da RFC 6455', () => {
    // O par de valores publicado na especificação: se este passa, qualquer
    // navegador aceita o 101 deste servidor.
    assert.equal(respostaPara('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('a constante é a da RFC', () => {
    assert.equal(GUID, '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  });

  it('chave ausente reclama', () => {
    assert.throws(() => respostaPara(undefined), ErroDeAperto);
  });

  it('a chave nova tem 16 bytes', () => {
    // 16 bytes em base64 dão sempre 24 caracteres.
    const chave = chaveNova();

    assert.equal(Buffer.from(chave, 'base64').length, 16);
    assert.equal(chave.length, 24);
    assert.notEqual(chaveNova(), chaveNova());
  });

  it('o 101 traz os quatro cabeçalhos obrigatórios', () => {
    const texto = resposta101('dGhlIHNhbXBsZSBub25jZQ==');

    assert.match(texto, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.match(texto, /Upgrade: websocket\r\n/);
    assert.match(texto, /Connection: Upgrade\r\n/);
    assert.match(texto, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/);
    assert.ok(texto.endsWith('\r\n\r\n'));
  });

  it('o subprotocolo só aparece quando foi escolhido', () => {
    assert.ok(!resposta101('dGhlIHNhbXBsZSBub25jZQ==').includes('Sec-WebSocket-Protocol'));
    assert.match(resposta101('dGhlIHNhbXBsZSBub25jZQ==', { protocolo: 'chat' }), /Sec-WebSocket-Protocol: chat/);
  });
});

describe('conferência do pedido', () => {
  it('aceita um pedido correto', () => {
    assert.equal(conferirPedido(pedido()).chave, 'dGhlIHNhbXBsZSBub25jZQ==');
  });

  it('recusa método diferente de GET', () => {
    assert.throws(() => conferirPedido({ ...pedido(), method: 'POST' }), /tem que ser GET/);
  });

  it('recusa sem Upgrade ou sem Connection', () => {
    assert.throws(() => conferirPedido(pedido({ upgrade: undefined })), /Upgrade ausente/);
    assert.throws(() => conferirPedido(pedido({ connection: 'keep-alive' })), /não pede upgrade/);
  });

  it('aceita Connection com vários valores, que é o que proxy manda', () => {
    assert.ok(conferirPedido(pedido({ connection: 'keep-alive, Upgrade' })));
    assert.ok(conferirPedido(pedido({ upgrade: 'WebSocket' })));
  });

  it('recusa versão diferente de 13 e pede a certa de volta', () => {
    let erro = null;

    try {
      conferirPedido(pedido({ 'sec-websocket-version': '8' }));
    } catch (capturado) {
      erro = capturado;
    }

    assert.ok(erro instanceof ErroDeAperto);
    assert.equal(erro.status, 426);
    assert.match(respostaDeRecusa(erro), new RegExp(`Sec-WebSocket-Version: ${VERSAO}`));
  });

  it('recusa chave ausente ou do tamanho errado', () => {
    assert.throws(() => conferirPedido(pedido({ 'sec-websocket-key': undefined })), /Falta o cabeçalho/);
    assert.throws(() => conferirPedido(pedido({ 'sec-websocket-key': 'YWJj' })), /16 bytes/);
  });

  it('lê os subprotocolos oferecidos', () => {
    const { protocolos } = conferirPedido(pedido({ 'sec-websocket-protocol': 'chat, superchat' }));

    assert.deepEqual(protocolos, ['chat', 'superchat']);
  });

  it('a preferência de subprotocolo é do servidor', () => {
    // O cliente lista o que sabe; quem escolhe é quem vai servir.
    assert.equal(escolherProtocolo(['chat', 'superchat'], ['superchat', 'chat']), 'superchat');
    assert.equal(escolherProtocolo(['chat'], ['superchat']), null);
    assert.equal(escolherProtocolo(['chat'], []), null);
  });
});

describe('recusa', () => {
  it('diz o status e o motivo, em vez de só cair', () => {
    // Soquete que abre, fica mudo e cai é o erro mais chato de depurar aqui.
    const texto = respostaDeRecusa(new ErroDeAperto('Nada escuta em /errado.', 404));

    assert.match(texto, /^HTTP\/1\.1 404 /);
    assert.match(texto, /Nada escuta em \/errado\./);
    assert.match(texto, /Connection: close/);
  });

  it('erro comum vira 400', () => {
    assert.match(respostaDeRecusa(new Error('qualquer coisa')), /^HTTP\/1\.1 400 Bad Request/);
  });
});

describe('lado do cliente', () => {
  it('lê ws:// e wss:// com a porta padrão certa', () => {
    assert.deepEqual(lerEndereco('ws://exemplo.com/sala?x=1'), {
      seguro: false,
      maquina: 'exemplo.com',
      porta: 80,
      caminho: '/sala?x=1',
      anfitriao: 'exemplo.com',
    });

    assert.equal(lerEndereco('wss://exemplo.com').porta, 443);
    assert.equal(lerEndereco('ws://exemplo.com:8080').porta, 8080);
    assert.equal(lerEndereco('ws://exemplo.com').caminho, '/');
  });

  it('recusa http:// e outros esquemas', () => {
    assert.throws(() => lerEndereco('http://exemplo.com'), ErroDeConexao);
  });

  it('o pedido tem tudo que o servidor confere', () => {
    const texto = pedidoDeUpgrade({
      caminho: '/sala',
      anfitriao: 'exemplo.com',
      chave: 'dGhlIHNhbXBsZSBub25jZQ==',
      protocolos: ['chat'],
      cabecalhos: { Origin: 'https://exemplo.com' },
    });

    // O melhor teste do cliente é o próprio servidor aceitar o que ele monta.
    const linhas = texto.split('\r\n');
    const cabecalhos = Object.fromEntries(
      linhas.slice(1).filter(Boolean).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]),
    );

    assert.equal(linhas[0], 'GET /sala HTTP/1.1');
    assert.ok(conferirPedido({ method: 'GET', headers: cabecalhos }));
    assert.equal(cabecalhos.origin, 'https://exemplo.com');
  });

  it('lê a resposta do servidor', () => {
    const { status, cabecalhos } = lerResposta(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: abc=\r\n',
    );

    assert.equal(status, 101);
    assert.equal(cabecalhos['sec-websocket-accept'], 'abc=');
  });
});
