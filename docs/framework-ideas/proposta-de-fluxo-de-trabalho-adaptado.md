# Fluxo adaptado para uma estrutura de multi agentes

> **Nota (2026-11-14).** Este texto é o registro das ideias iniciais do dono e não foi reescrito. A referência é a [arquitetura](arquitetura.md) v0.32 e o [fluxo da peça](fluxo-da-peca.md). Quando divergirem, vale a arquitetura.
>
> O que mudou:
> - Passo 1: a necessidade abre uma peça num cenário (projeto, tarefa ou chat). A tarefa repetitiva vira cenário do tipo tarefa, com definição versionada pelo `task.define`, que segue as mesmas regras da peça (§5.20, v0.32).
> - Passos 2 e 3: as dúvidas do plano vão ao Produtor (CLARIFYING) antes do Revisor, e a volta ao Autor tem contador (§5.4).
> - Passo 4: o roteiro passa por validação em código, e o Autor revisa todo roteiro, não só a correção (§5.4).
> - Passo 5: o elenco sai da seleção por prioridade e cota (§5.7), e o daemon abre as sessões (§4). Cada demanda tem `verify`, e o Ator pode encerrar como `blocked` (§5.4).
> - Passo 6: o Crítico pode ser dispensado por decisão registrada do Produtor (§5.4).
> - Passo 7: em vez de "total liberdade de PR e merge", vale `delivery.mode`, com PR por padrão (§5.5).
> - Passo 8: numa crítica mista vence a falha mais grave, e o conflito na integração é falha de roteiro (§5.4).
> - Todo laço tem contador, e esgotado vai ao Produtor com um menu fixo. A exceção crítica é uma lista fechada (§5.4).
> - Passo 9: um pedido de mudança depois da entrega abre uma peça nova, ligada à anterior (§5.4).

1. Produtor define uma necessidade qualquer. Pode ser uma nova feature, um novo projeto, bug fixing, uma analise de dados, uma pesquisa, resumo de varios documentos ou tarefa repetitiva que vai usar varios agentes.

2. Autor recebe a necessidade do produtor e monta um plano de ação detalhado que atenda a necessidade do Produtor.

3. Revisor recebe o plano de ação do Autor e revisa ela. Se tiver algum problema ela volta para o Autor corrigir, senão segue pro roteirista.

4. Roteirista recebe o plano revisado do Revisor e prepara ele para ser trabalhado. Define a sua complexidade e em quantas demandas ele será dividido e quais podem ser executadas em paralelo.

5. Diretor recebe o roteiro (demandas) e separa o elenco de atores que vão trabalhar nelas e acompanha os atores durante o seu trabalho. Cada Ator trabalha independente, mas o trabalho conjunto de todos define a entrega.

6. O Critico olha o trabalho conjunto dos Atores e compara com o roteiro e a obra revisada e emite uma analise do que foi entregue pelos Atores.

7. O Diretor recebe a critica e aciona a equipe para executar as correções no caso de uma critica negativa ou em caso positivo procede para encerramento da peça. No encerramento da peça o Diretor tem total liberdade de PR e merge do que foi realizado.

8. No caso de correções o Diretor pode proceder conforme o tipo de problema encontrado:

    * Se o problema for da execução dos Atores, retorna ao passo 5 para ser corrigido.
      
    * Se o problema for do roteiro, retorna ao passo 4 para o roteirista corrigir e a correção deve ser revisada pelo Autor. Se as correções forem aprovadas, elas retornam para o Diretor, para execução.
      
    *  Se for um problema estrutural do plano de ação do Autor, retorna aos passos 1 e 2 para o Autor corrigir, com revisão do Revisor e depois volta ao Roteirista e assim por diante.
  
9. Volta para o passo 1 para a proxima necessidade do Produtor.
